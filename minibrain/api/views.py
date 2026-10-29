from pathlib import Path

from minibrain.api.schemas import (
    ColumnInfo,
    JobInfo,
    KeyInfo,
    MappingInfo,
    MinibrainDetail,
    MinibrainSummary,
    Mistake,
    SnapshotInfo,
    SourceInfo,
    SplitScore,
    VersionInfo,
)
from minibrain.data.sources import describe
from minibrain.registry.models import ACTIVE_JOB_STATUSES, ApiKey, Job, Minibrain, Snapshot, Version
from minibrain.registry.service import latest_snapshot
from minibrain.serve.resolve import model_names
from minibrain.settings import Settings


def staging_path(settings: Settings, minibrain: Minibrain) -> Path:
    return settings.minibrain_dir(minibrain.slug) / "staging.duckdb"


def source_info(settings: Settings, minibrain: Minibrain) -> SourceInfo | None:
    staging = staging_path(settings, minibrain)
    if minibrain.source_file is None or not staging.exists():
        return None
    columns, rows = describe(staging)
    return SourceInfo(
        file=minibrain.source_file,
        columns=[ColumnInfo(name=column.name, type=column.type) for column in columns],
        rows=rows,
    )


def snapshot_info(snapshot: Snapshot) -> SnapshotInfo:
    return SnapshotInfo(
        hash=snapshot.hash, counts=snapshot.counts, labels=snapshot.labels, created_at=snapshot.created_at
    )


def job_info(job: Job) -> JobInfo:
    return JobInfo(
        id=job.id,
        version=job.version.number,
        kind=job.kind,
        status=job.status,
        progress=job.progress,
        error=job.error,
        created_at=job.created_at,
        started_at=job.started_at,
        finished_at=job.finished_at,
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


def summary(minibrain: Minibrain) -> MinibrainSummary:
    return MinibrainSummary(
        slug=minibrain.slug,
        name=minibrain.name,
        task=minibrain.task,
        current_version=minibrain.current_version,
        versions=len(minibrain.versions),
        active_jobs=sum(job.status in ACTIVE_JOB_STATUSES for job in minibrain.jobs),
    )


def detail(settings: Settings, minibrain: Minibrain) -> MinibrainDetail:
    current = latest_snapshot(minibrain)
    return MinibrainDetail(
        slug=minibrain.slug,
        name=minibrain.name,
        task=minibrain.task,
        current_version=minibrain.current_version,
        versions=len(minibrain.versions),
        active_jobs=sum(job.status in ACTIVE_JOB_STATUSES for job in minibrain.jobs),
        base_model=minibrain.base_model,
        source=source_info(settings, minibrain),
        mapping=MappingInfo(
            input_column=minibrain.input_column, label_column=minibrain.label_column, sql=minibrain.sql
        ),
        snapshot=snapshot_info(current) if current is not None else None,
        models=model_names(minibrain),
    )


def key_info(key: ApiKey) -> KeyInfo:
    return KeyInfo(
        id=key.id, name=key.name, prefix=key.prefix, created_at=key.created_at, last_used_at=key.last_used_at
    )
