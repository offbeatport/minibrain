from dataclasses import asdict
from typing import Any

from sqlalchemy.orm import Session, object_session

from minibrain.api.schemas import (
    AttemptInfo,
    ChangeInfo,
    CheckInfo,
    ColumnInfo,
    EvalCost,
    JobDetail,
    JobInfo,
    KeyInfo,
    KeyModel,
    MappingInfo,
    MinibrainDetail,
    MinibrainSummary,
    Mistake,
    RequestBodiesInfo,
    SnapshotInfo,
    SourceInfo,
    SplitScore,
    TeardownInfo,
    TeardownKindName,
    TeardownState,
    VersionInfo,
)
from minibrain.data.shared import table_of
from minibrain.data.snapshots import Changes, changes_since, model_snapshot
from minibrain.data.sources import SourceError, describe
from minibrain.policy import bodies_choice
from minibrain.registry.files import store_for
from minibrain.registry.models import (
    ACTIVE_JOB_STATUSES,
    ApiKey,
    Dataset,
    Job,
    JobAttempt,
    Minibrain,
    Model,
    Snapshot,
    Teardown,
    TeardownKind,
    TeardownStatus,
    TeardownStep,
    Version,
)
from minibrain.registry.prices import DevicePrices, eval_cost
from minibrain.registry.service import find_version, held_out_accuracy, latest_snapshot
from minibrain.serve.resolve import model_names
from minibrain.settings import Settings

TEARDOWN_LABELS: dict[tuple[str, str], str] = {
    (TeardownKind.DELETE, TeardownStatus.RUNNING): "Deleting",
    (TeardownKind.DELETE, TeardownStatus.FAILED): "Delete failed",
    (TeardownKind.UNDEPLOY, TeardownStatus.RUNNING): "Stopping",
    (TeardownKind.UNDEPLOY, TeardownStatus.FAILED): "Stop failed",
    (TeardownKind.REMOVE_FILES, TeardownStatus.RUNNING): "Removing files",
    (TeardownKind.REMOVE_FILES, TeardownStatus.FAILED): "Remove failed",
}
STOPPING_TEXT: dict[str, str] = {
    TeardownKind.DELETE: "Gateways stop routing it and engines unload it once in-flight requests finish; then its "
    "files and records are removed.",
    TeardownKind.UNDEPLOY: "Gateways stop routing it and engines unload it once in-flight requests finish.",
    TeardownKind.REMOVE_FILES: "Engines release it once in-flight requests finish; then its files are removed.",
}
TEARDOWN_KINDS: dict[str, TeardownKindName] = {
    TeardownKind.DELETE: "delete",
    TeardownKind.UNDEPLOY: "undeploy",
    TeardownKind.REMOVE_FILES: "remove_files",
}
TEARDOWN_STATES: dict[str, TeardownState] = {TeardownStatus.RUNNING: "running", TeardownStatus.FAILED: "failed"}
REMOVING_TEXT: dict[str, str] = {
    TeardownKind.DELETE: "Removing its files and records.",
    TeardownKind.REMOVE_FILES: "Removing its files.",
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


def source_info(settings: Settings, minibrain: Minibrain) -> SourceInfo | None:
    dataset = minibrain.dataset
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
    return MappingInfo(input_column=dataset.input_column, label_column=dataset.label_column, sql=dataset.sql)


def snapshot_info(snapshot: Snapshot) -> SnapshotInfo:
    return SnapshotInfo(
        id=snapshot.id,
        hash=snapshot.hash,
        dataset=snapshot.dataset.slug if snapshot.dataset is not None else None,
        rows=snapshot.rows or sum(snapshot.counts.values()),
        size=snapshot.size,
        counts=snapshot.counts,
        labels=snapshot.labels,
        saved=snapshot.saved,
        versions=sorted(f"{version.minibrain.slug}@{version.number}" for version in snapshot.versions),
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


def model_changes(settings: Settings, minibrain: Minibrain) -> ChangeInfo | None:
    if minibrain.dataset is None:
        return None
    try:
        return change_info(changes_since(settings, minibrain.dataset, model_snapshot(minibrain)))
    except SourceError:
        return None


def job_fields(job: Job) -> dict:
    return {
        "id": job.id,
        "minibrain": job.minibrain.slug if job.minibrain else None,
        "minibrain_name": job.minibrain.name if job.minibrain else None,
        "model": job.model_id,
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


def split_score(metrics: dict | None, key: str) -> SplitScore | None:
    split = (metrics or {}).get(key)
    return SplitScore.model_validate(split) if split else None


def latest_job(minibrain: Minibrain, version: Version) -> Job | None:
    jobs = [job for job in minibrain.jobs if job.version_id == version.id]
    return max(jobs, key=lambda job: job.id, default=None)


def cost_info(metrics: dict[str, Any] | None, prices: DevicePrices) -> EvalCost | None:
    found = eval_cost(metrics, prices)
    return None if found is None else EvalCost.model_validate(asdict(found))


def version_info(minibrain: Minibrain, version: Version, prices: DevicePrices | None = None) -> VersionInfo:
    metrics = version.metrics or {}
    latency = metrics.get("latency") or {}
    job = latest_job(minibrain, version)
    return VersionInfo(
        number=version.number,
        kind=version.kind,
        status=version.status,
        current=minibrain.current_version == version.number,
        snapshot_hash=version.snapshot.hash,
        snapshot_id=version.snapshot.id,
        snapshot_dataset=version.snapshot.dataset.slug if version.snapshot.dataset is not None else None,
        snapshot_rows=version.snapshot.rows or sum(version.snapshot.counts.values()),
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
    )


def current_accuracy(minibrain: Minibrain) -> float | None:
    if minibrain.current_version is None:
        return None
    version = find_version(minibrain, minibrain.current_version)
    return held_out_accuracy(version) if version is not None and version.metrics else None


def summary(minibrain: Minibrain) -> MinibrainSummary:
    return MinibrainSummary(
        slug=minibrain.slug,
        name=minibrain.name,
        task=minibrain.task,
        base_model=minibrain.base_model,
        current_version=minibrain.current_version,
        deployed=minibrain.deployed,
        current_accuracy=current_accuracy(minibrain),
        versions=len(minibrain.versions),
        active_jobs=sum(job.status in ACTIVE_JOB_STATUSES for job in minibrain.jobs),
    )


def bodies_info(minibrain: Minibrain) -> RequestBodiesInfo:
    session = object_session(minibrain)
    kept, lock = bodies_choice(session, minibrain.request_bodies) if session else (minibrain.request_bodies, None)
    return RequestBodiesInfo(kept=kept, locked=lock is not None, source=lock or "model")


def detail(settings: Settings, minibrain: Minibrain) -> MinibrainDetail:
    current = latest_snapshot(minibrain)
    return MinibrainDetail(
        slug=minibrain.slug,
        name=minibrain.name,
        task=minibrain.task,
        base_model=minibrain.base_model,
        current_version=minibrain.current_version,
        deployed=minibrain.deployed,
        current_accuracy=current_accuracy(minibrain),
        versions=len(minibrain.versions),
        active_jobs=sum(job.status in ACTIVE_JOB_STATUSES for job in minibrain.jobs),
        source=source_info(settings, minibrain),
        mapping=mapping_info(minibrain.dataset),
        dataset=minibrain.dataset.slug if minibrain.dataset else None,
        dataset_name=minibrain.dataset.name if minibrain.dataset else None,
        snapshot=snapshot_info(current) if current is not None else None,
        changed=model_changes(settings, minibrain),
        models=model_names(minibrain),
        request_bodies=bodies_info(minibrain),
        teardown=teardown_info(minibrain.teardown),
    )


def key_models(session: Session, key: ApiKey) -> list[KeyModel]:
    found: list[KeyModel] = []
    for scope in key.scopes:
        if scope.minibrain is not None:
            found.append(KeyModel(kind="custom", key=scope.minibrain.slug, name=scope.minibrain.name))
        elif scope.model_id is not None:
            model = session.get(Model, scope.model_id)
            found.append(KeyModel(kind="base", key=scope.model_id, name=model.name if model else scope.model_id))
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
