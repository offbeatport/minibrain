from sqlalchemy.orm import Session

from minibrain.api.schemas import (
    AttemptInfo,
    ChangeInfo,
    CheckInfo,
    ColumnInfo,
    JobDetail,
    JobInfo,
    KeyInfo,
    KeyModel,
    MappingInfo,
    MinibrainDetail,
    MinibrainSummary,
    Mistake,
    SnapshotInfo,
    SourceInfo,
    SplitScore,
    VersionInfo,
)
from minibrain.data.shared import table_of
from minibrain.data.snapshots import Changes, changes_since, model_snapshot
from minibrain.data.sources import SourceError, describe
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
    Version,
)
from minibrain.registry.service import find_version, held_out_accuracy, latest_snapshot
from minibrain.serve.resolve import model_names
from minibrain.settings import Settings


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


def version_info(minibrain: Minibrain, version: Version) -> VersionInfo:
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
