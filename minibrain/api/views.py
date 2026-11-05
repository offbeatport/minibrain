from dataclasses import asdict
from typing import Any

from sqlalchemy.orm import Session, object_session

from minibrain.api.schemas import (
    AttemptInfo,
    ChangeInfo,
    CheckInfo,
    ColumnInfo,
    ConfusionInfo,
    ContractInfo,
    DecisionInfo,
    EvalCost,
    FieldScoreInfo,
    GraderConfig,
    JobDetail,
    JobInfo,
    KeyInfo,
    KeyModel,
    LabelScoreInfo,
    MappingInfo,
    Mistake,
    ModelDetail,
    ModelSummary,
    PromotionInfo,
    RequestBodiesInfo,
    ScoreInfo,
    SnapshotInfo,
    SourceInfo,
    SplitScore,
    TeardownInfo,
    TeardownKindName,
    TeardownState,
    VersionInfo,
)
from minibrain.data.shared import table_of
from minibrain.data.snapshots import Changes, changes_since, version_number
from minibrain.data.sources import SourceError, describe
from minibrain.data.templates import plain_columns
from minibrain.policy import bodies_choice
from minibrain.registry.files import store_for
from minibrain.registry.models import (
    ACTIVE_JOB_STATUSES,
    ApiKey,
    BaseModel,
    Dataset,
    Job,
    JobAttempt,
    Model,
    Snapshot,
    Teardown,
    TeardownKind,
    TeardownStatus,
    TeardownStep,
    Version,
    VersionStatus,
)
from minibrain.registry.prices import DevicePrices, eval_cost
from minibrain.registry.service import find_version, latest_snapshot
from minibrain.serve.resolve import model_names
from minibrain.settings import Settings
from minibrain.tasks.contracts import Contract
from minibrain.tasks.service import (
    contract_of,
    decision,
    held_out_score,
    latest_version_of,
    preset_of,
    rule_of,
    version_contract,
    version_metric,
)

TEARDOWN_LABELS: dict[tuple[str, str], str] = {
    (TeardownKind.DELETE, TeardownStatus.RUNNING): "Deleting",
    (TeardownKind.DELETE, TeardownStatus.FAILED): "Delete failed",
    (TeardownKind.UNDEPLOY, TeardownStatus.RUNNING): "Stopping",
    (TeardownKind.UNDEPLOY, TeardownStatus.FAILED): "Stop failed",
}
STOPPING_TEXT: dict[str, str] = {
    TeardownKind.DELETE: "Gateways stop routing it and engines unload it once in-flight requests finish; then its "
    "files and records are removed.",
    TeardownKind.UNDEPLOY: "Gateways stop routing it and engines unload it once in-flight requests finish.",
}
TEARDOWN_KINDS: dict[str, TeardownKindName] = {
    TeardownKind.DELETE: "delete",
    TeardownKind.UNDEPLOY: "undeploy",
}
TEARDOWN_STATES: dict[str, TeardownState] = {TeardownStatus.RUNNING: "running", TeardownStatus.FAILED: "failed"}
REMOVING_TEXT: dict[str, str] = {
    TeardownKind.DELETE: "Removing its files and records.",
}


def teardown_text(teardown: Teardown) -> str:
    if teardown.status == TeardownStatus.FAILED:
        return teardown.error or "It stopped without a message."
    waiting = list(teardown.detail.get("waiting") or [])
    if waiting:
        return f"Waiting for {'; '.join(waiting)}."
    if teardown.step == TeardownStep.REMOVING:
        return REMOVING_TEXT.get(teardown.kind, STOPPING_TEXT[teardown.kind])
    return STOPPING_TEXT[teardown.kind]


def teardown_info(teardown: Teardown | None, part_of: str | None = None) -> TeardownInfo | None:
    if teardown is None:
        return None
    detail = teardown.detail
    return TeardownInfo(
        kind=TEARDOWN_KINDS[teardown.kind],
        state=TEARDOWN_STATES[teardown.status],
        label=TEARDOWN_LABELS[(teardown.kind, teardown.status)],
        detail=teardown_text(teardown),
        error=teardown.error,
        started_by=teardown.actor,
        started_at=teardown.started_at,
        waiting=list(detail.get("waiting") or []),
        models=list(detail.get("models") or []),
        part_of=part_of,
        cascade=bool(detail.get("cascade")),
        undeploy=bool(detail.get("live")),
    )


def source_info(settings: Settings, model: Model) -> SourceInfo | None:
    dataset = model.dataset
    source = None if dataset is None else dataset.source or next(iter(dataset.sources), None)
    if source is None:
        return None
    columns, rows = describe(table_of(settings, store_for(settings), source))
    return SourceInfo(
        file=source.filename,
        columns=[ColumnInfo(name=column.name, type=column.type) for column in columns],
        rows=rows,
    )


def mapping_info(dataset: Dataset | None) -> MappingInfo:
    if dataset is None:
        return MappingInfo(input_column=None, label_column=None, sql=None)
    input_column, label_column = plain_columns(dataset.template)
    return MappingInfo(input_column=input_column, label_column=label_column, template=dataset.template, sql=dataset.sql)


def snapshot_info(snapshot: Snapshot) -> SnapshotInfo:
    users = [*snapshot.versions, *(version for copy in snapshot.copies for version in copy.versions)]
    return SnapshotInfo(
        id=snapshot.id,
        hash=snapshot.hash,
        dataset=snapshot.dataset.slug if snapshot.dataset is not None else None,
        number=snapshot.number,
        base_number=snapshot.base.number if snapshot.base is not None else None,
        rows=snapshot.rows or sum(snapshot.counts.values()),
        size=snapshot.size,
        counts=snapshot.counts,
        labels=snapshot.labels,
        saved=snapshot.saved,
        versions=sorted({f"{version.model.slug}@{version.number}" for version in users}),
        created_at=snapshot.created_at,
        taken_at=snapshot.taken_at,
        checks=check_infos(snapshot),
        feedback_rows=snapshot.feedback_rows,
    )


def check_infos(snapshot: Snapshot) -> list[CheckInfo]:
    dismissed = (snapshot.dataset.dismissed if snapshot.dataset is not None else None) or {}
    return [
        CheckInfo.model_validate(item | {"dismissed": dismissed.get(str(item["check"])) == item["signature"]})
        for item in snapshot.checks or []
    ]


def change_info(changes: Changes | None) -> ChangeInfo | None:
    return None if changes is None else ChangeInfo(data=changes.data, query=changes.query, dataset=changes.dataset)


def model_changes(settings: Settings, model: Model) -> ChangeInfo | None:
    if model.dataset is None:
        return None
    try:
        return change_info(changes_since(settings, model.dataset, latest_snapshot(model)))
    except SourceError:
        return None


def job_fields(job: Job) -> dict:
    return {
        "id": job.id,
        "model": job.model.slug if job.model else None,
        "model_name": job.model.name if job.model else None,
        "base_model": job.base_model_id,
        "version": job.version.number if job.version else None,
        "kind": job.kind,
        "status": job.status,
        "progress": job.progress,
        "error": job.error,
        "attempt": job.attempt,
        "max_attempts": job.max_attempts,
        "cancel_requested": job.cancel_requested,
        "retry_of": job.retry_of,
        "created_at": job.created_at,
        "run_after": job.run_after,
        "started_at": job.started_at,
        "finished_at": job.finished_at,
    }


def job_info(job: Job) -> JobInfo:
    return JobInfo(**job_fields(job))


def attempt_info(attempt: JobAttempt) -> AttemptInfo:
    return AttemptInfo(
        number=attempt.number,
        worker=attempt.worker,
        outcome=attempt.outcome,
        error=attempt.error,
        retryable=attempt.retryable,
        log=attempt.log_artifact_id,
        started_at=attempt.started_at,
        finished_at=attempt.finished_at,
    )


def job_detail(job: Job) -> JobDetail:
    return JobDetail(
        **job_fields(job),
        attempts=[attempt_info(attempt) for attempt in job.attempts],
        result=job.result,
        outputs=dict(job.outputs or {}),
    )


def contract_info(contract: Contract) -> ContractInfo:
    labels = contract.labels
    schema = None if labels is not None else contract.schema
    return ContractInfo(kind=contract.kind, json_schema=schema, labels=list(labels) if labels is not None else None)


def grader_infos(configs: list[dict[str, Any]]) -> list[GraderConfig]:
    return [GraderConfig.model_validate(config) for config in configs]


def split_score(metrics: dict | None, key: str) -> SplitScore | None:
    split = (metrics or {}).get(key)
    if not split or "scores" not in split:
        return None
    reports = split.get("reports") or {}
    labelled = reports.get("label_accuracy") or {}
    return SplitScore(
        examples=int(split.get("examples", 0)),
        invalid_rate=float(split.get("invalid_rate", 0.0)),
        scores=[ScoreInfo.model_validate(item) for item in split["scores"]],
        labels=[LabelScoreInfo.model_validate(item) for item in labelled.get("labels", [])],
        confusion=[ConfusionInfo.model_validate(item) for item in labelled.get("confusion", [])],
        fields=[
            FieldScoreInfo.model_validate(item) for item in (reports.get("json_field_match") or {}).get("fields", [])
        ],
        judge_pending=int((reports.get("judge") or {}).get("pending", 0)),
    )


def latest_job(model: Model, version: Version) -> Job | None:
    jobs = [job for job in model.jobs if job.version_id == version.id]
    return max(jobs, key=lambda job: job.id, default=None)


def cost_info(metrics: dict[str, Any] | None, prices: DevicePrices) -> EvalCost | None:
    found = eval_cost(metrics, prices)
    return None if found is None else EvalCost.model_validate(asdict(found))


def version_info(model: Model, version: Version, prices: DevicePrices | None = None) -> VersionInfo:
    metrics = version.metrics or {}
    latency = metrics.get("latency") or {}
    job = latest_job(model, version)
    snapshot = version.snapshot
    ready = version.status == VersionStatus.READY
    return VersionInfo(
        number=version.number,
        kind=version.kind,
        status=version.status,
        current=model.current_version == version.number,
        snapshot_hash=snapshot.hash if snapshot is not None else None,
        snapshot_id=snapshot.id if snapshot is not None else None,
        snapshot_dataset=snapshot.dataset.slug if snapshot is not None and snapshot.dataset is not None else None,
        snapshot_number=version_number(snapshot) if snapshot is not None else None,
        snapshot_rows=(snapshot.rows or sum(snapshot.counts.values())) if snapshot is not None else 0,
        recipe=version.recipe,
        golden=split_score(metrics, "golden"),
        held_out=split_score(metrics, "eval"),
        latency_p50_ms=latency.get("p50_ms"),
        latency_p95_ms=latency.get("p95_ms"),
        prompt_tokens=metrics.get("prompt_tokens"),
        cost=cost_info(metrics, prices or DevicePrices()),
        mistakes=[Mistake.model_validate(item) for item in (metrics.get("eval") or {}).get("mistakes", [])],
        job=job_info(job) if job is not None else None,
        created_at=version.created_at,
        contract=contract_info(version_contract(version)),
        contract_number=version.contract_number,
        instructions=version.instructions,
        shots=len(version.shots or []),
        graders=grader_infos(version.graders),
        main_metric=version_metric(version),
        score=held_out_score(version),
        promotion=DecisionInfo.model_validate(decision(model, version).as_dict()) if ready else None,
        live_at=version.live_at,
        view=preset_of(model).view,
    )


def current_score(model: Model) -> float | None:
    if model.current_version is None:
        return None
    version = find_version(model, model.current_version)
    return held_out_score(version) if version is not None else None


def model_metric(model: Model) -> str | None:
    newest = latest_version_of(model)
    return version_metric(newest) if newest is not None else None


def current_contract(model: Model) -> int:
    newest = latest_version_of(model)
    return newest.contract_number if newest is not None else 1


def summary(model: Model) -> ModelSummary:
    return ModelSummary(
        slug=model.slug,
        name=model.name,
        preset=model.preset,
        base_model=model.base_model,
        current_version=model.current_version,
        deployed=model.deployed,
        main_metric=model_metric(model),
        current_score=current_score(model),
        versions=len(model.versions),
        active_jobs=sum(job.status in ACTIVE_JOB_STATUSES for job in model.jobs),
    )


def bodies_info(model: Model) -> RequestBodiesInfo:
    session = object_session(model)
    kept, lock = bodies_choice(session, model.request_bodies) if session else (model.request_bodies, None)
    return RequestBodiesInfo(kept=kept, locked=lock is not None, source=lock or "model")


def detail(settings: Settings, model: Model) -> ModelDetail:
    current = latest_snapshot(model)
    return ModelDetail(
        slug=model.slug,
        name=model.name,
        preset=model.preset,
        base_model=model.base_model,
        current_version=model.current_version,
        deployed=model.deployed,
        main_metric=model_metric(model),
        current_score=current_score(model),
        versions=len(model.versions),
        active_jobs=sum(job.status in ACTIVE_JOB_STATUSES for job in model.jobs),
        source=source_info(settings, model),
        mapping=mapping_info(model.dataset),
        dataset=model.dataset.slug if model.dataset else None,
        dataset_name=model.dataset.name if model.dataset else None,
        snapshot=snapshot_info(current) if current is not None else None,
        changed=model_changes(settings, model),
        models=model_names(model),
        request_bodies=bodies_info(model),
        teardown=teardown_info(model.teardown),
        contract=contract_info(contract_of(model)),
        contract_number=current_contract(model),
        instructions=model.instructions or "",
        graders=grader_infos(model.graders),
        promotion=PromotionInfo.model_validate(rule_of(model).as_dict()),
    )


def key_models(session: Session, key: ApiKey) -> list[KeyModel]:
    found: list[KeyModel] = []
    for scope in key.scopes:
        if scope.model is not None:
            found.append(KeyModel(kind="custom", key=scope.model.slug, name=scope.model.name))
        elif scope.base_model_id is not None:
            model = session.get(BaseModel, scope.base_model_id)
            found.append(
                KeyModel(kind="base", key=scope.base_model_id, name=model.name if model else scope.base_model_id)
            )
    return found


def key_info(session: Session, key: ApiKey) -> KeyInfo:
    return KeyInfo(
        id=key.id,
        name=key.name,
        prefix=key.prefix,
        created_at=key.created_at,
        last_used_at=key.last_used_at,
        expires_at=key.expires_at,
        models=key_models(session, key),
    )
