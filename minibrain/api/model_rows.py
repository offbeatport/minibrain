import statistics
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, time, timedelta
from typing import Any

from sqlalchemy import ColumnElement, func, select
from sqlalchemy.orm import InstrumentedAttribute, Session

from minibrain.api.model_health import HealthContext, base_health, custom_health, version_health
from minibrain.api.schemas import (
    Activity,
    Availability,
    AvailabilityState,
    Deployment,
    DeploymentState,
    Health,
    ModelRow,
    Stage,
    TeardownInfo,
    Usage,
    VersionRow,
)
from minibrain.api.views import cost_info, teardown_info
from minibrain.artifacts import ArtifactStore
from minibrain.models.hardware import needed_bytes
from minibrain.models.health import content_hash
from minibrain.models.registry import files_present
from minibrain.models.rules import publisher_of
from minibrain.models.sources import HUB
from minibrain.registry.models import (
    ACTIVE_JOB_STATUSES,
    CatalogVariant,
    Job,
    JobKind,
    JobStatus,
    KeyScope,
    Minibrain,
    Model,
    ModelStatus,
    RequestLog,
    Teardown,
    TeardownKind,
    TeardownStatus,
    TeardownStep,
    Version,
    VersionKind,
    VersionStatus,
    now,
)
from minibrain.registry.prices import DevicePrices, load_prices
from minibrain.registry.service import held_out_accuracy, latest_snapshot
from minibrain.settings import Settings

FAILED_LABELS: dict[str, str] = {
    JobKind.TRAIN: "Training failed",
    JobKind.EVAL: "Scoring failed",
    JobKind.PREPARE: "Dataset build failed",
    JobKind.DOWNLOAD: "Download failed",
    JobKind.IMPORT: "Import failed",
    JobKind.VERIFY: "Verify failed",
    JobKind.REPAIR: "Repair failed",
}
TRANSFER_LABELS: dict[str, str] = {
    JobKind.DOWNLOAD: "Downloading",
    JobKind.IMPORT: "Importing",
    JobKind.VERIFY: "Verifying files",
    JobKind.REPAIR: "Repairing",
}
STATE_LABELS = {
    "running": "Running",
    "starting": "Starting",
    "unhealthy": "Unhealthy",
    "stopping": "Stopping",
    "stop_failed": "Stop failed",
}
USAGE_DAYS = 7
FAILED_STATUS = 500
LATENCY_SAMPLE = 2000


EngineHealth = Callable[[str], str | None]


def running_progress(job: Job) -> float | None:
    return job.progress if job.status == JobStatus.RUNNING and job.progress > 0 else None


def version_label(job: Job) -> str:
    number = job.version.number if job.version is not None else None
    if job.kind == JobKind.PREPARE:
        return "Building dataset"
    verb = "training" if job.kind == JobKind.TRAIN else "evaluating"
    return f"v{number} {verb}" if number is not None else verb.capitalize()


def active_activity(job: Job) -> Activity:
    label = TRANSFER_LABELS.get(job.kind) or version_label(job)
    queued = job.status == JobStatus.QUEUED
    if queued:
        label += " · retrying" if job.attempt > 0 else " · queued"
    return Activity(
        state="queued" if queued else "running",
        label=label,
        kind=job.kind,
        version=job.version.number if job.version is not None else None,
        progress=running_progress(job),
        job_id=job.id,
    )


def candidate(minibrain: Minibrain) -> Version | None:
    current = minibrain.current_version if minibrain.current_version is not None else -1
    ready = [v for v in minibrain.versions if v.status == VersionStatus.READY and v.number > current]
    return max(ready, key=lambda v: v.number, default=None)


def custom_activity(minibrain: Minibrain, jobs: list[Job]) -> Activity:
    active = next((job for job in jobs if job.status in ACTIVE_JOB_STATUSES), None)
    if active is not None:
        return active_activity(active)
    latest = jobs[0] if jobs else None
    if latest is not None and latest.status == JobStatus.FAILED:
        version = latest.version.number if latest.version is not None else None
        label = FAILED_LABELS.get(latest.kind, "Job failed")
        return Activity(state="failed", label=label, kind=latest.kind, version=version, job_id=latest.id)
    ready = candidate(minibrain)
    if ready is not None:
        return Activity(state="ready", label=f"v{ready.number} ready", version=ready.number)
    if latest_snapshot(minibrain) is None:
        return Activity(state="needs_examples", label="Needs examples")
    return Activity(state="idle", label="No active jobs")


def data_stage(minibrain: Minibrain, active: dict[str, Job], failed: Job | None) -> Stage:
    job = active.get(JobKind.PREPARE)
    if job is not None:
        return Stage(key="data", state="active", label="Building dataset", progress=running_progress(job))
    snapshot = latest_snapshot(minibrain)
    if snapshot is not None:
        return Stage(key="data", state="done", label=f"{sum(snapshot.counts.values()):,} examples")
    if failed is not None and failed.kind == JobKind.PREPARE:
        return Stage(key="data", state="failed", label="Dataset build failed")
    return Stage(key="data", state="todo", label="Add training data")


def train_stage(minibrain: Minibrain, active: dict[str, Job], failed: Job | None) -> Stage:
    job = active.get(JobKind.TRAIN)
    if job is not None:
        return Stage(key="train", state="active", label=version_label(job), progress=running_progress(job))
    if failed is not None and failed.kind == JobKind.TRAIN:
        return Stage(key="train", state="failed", label=FAILED_LABELS[JobKind.TRAIN])
    built = [v.number for v in minibrain.versions if v.status != VersionStatus.FAILED]
    if built:
        return Stage(key="train", state="done", label=f"v{max(built)}")
    return Stage(key="train", state="todo", label="Train")


def scored(minibrain: Minibrain) -> list[Version]:
    return [v for v in minibrain.versions if v.status == VersionStatus.READY and v.metrics]


def evaluate_stage(minibrain: Minibrain, active: dict[str, Job], failed: Job | None) -> Stage:
    job = active.get(JobKind.EVAL)
    if job is not None:
        return Stage(key="evaluate", state="active", label=version_label(job), progress=running_progress(job))
    if failed is not None and failed.kind == JobKind.EVAL:
        return Stage(key="evaluate", state="failed", label=FAILED_LABELS[JobKind.EVAL])
    latest = max(scored(minibrain), key=lambda v: v.number, default=None)
    if latest is not None:
        return Stage(key="evaluate", state="done", label=f"{held_out_accuracy(latest):.0%} on v{latest.number}")
    return Stage(key="evaluate", state="todo", label="Score")


def deploy_stage(minibrain: Minibrain) -> Stage:
    if minibrain.deployed:
        live = f"v{minibrain.current_version}" if minibrain.current_version is not None else "Base model"
        return Stage(key="deploy", state="done", label=f"{live} live")
    return Stage(key="deploy", state="todo", label="Not deployed")


def custom_stages(minibrain: Minibrain, jobs: list[Job]) -> list[Stage]:
    active: dict[str, Job] = {}
    for job in jobs:
        if job.status in ACTIVE_JOB_STATUSES:
            active.setdefault(job.kind, job)
    failed = jobs[0] if jobs and jobs[0].status == JobStatus.FAILED else None
    return [
        data_stage(minibrain, active, failed),
        train_stage(minibrain, active, failed),
        evaluate_stage(minibrain, active, failed),
        deploy_stage(minibrain),
    ]


def shown_accuracy(minibrain: Minibrain) -> float | None:
    versions = scored(minibrain)
    current = next((v for v in versions if v.number == minibrain.current_version), None)
    shown = current or max(versions, key=lambda v: v.number, default=None)
    return held_out_accuracy(shown) if shown is not None else None


def usage_window() -> tuple[datetime, list[str]]:
    today = now().astimezone(UTC).date()
    days = [today - timedelta(days=offset) for offset in range(USAGE_DAYS - 1, -1, -1)]
    return datetime.combine(days[0], time.min, tzinfo=UTC), [day.isoformat() for day in days]


def usage_for(
    session: Session, keys: Sequence[InstrumentedAttribute[Any]], scope: ColumnElement[bool]
) -> dict[tuple[Any, ...], Usage]:
    since, days = usage_window()
    before = since - timedelta(days=USAGE_DAYS)
    recent = RequestLog.at >= since
    day = func.date(RequestLog.at)
    width = len(keys)

    def grouped(*columns: Any, where: Sequence[ColumnElement[bool]]) -> list[Any]:
        return list(session.execute(select(*keys, *columns).where(scope, *where).group_by(*keys, *columns[:-1])))

    daily: dict[tuple[Any, ...], dict[str, int]] = {}
    for row in grouped(day, func.count(), where=[recent]):
        daily.setdefault(tuple(row[:width]), {})[str(row[width])[:10]] = row[width + 1]
    earlier = (RequestLog.at >= before) & (RequestLog.at < since)
    previous = {tuple(row[:width]): row[width] for row in grouped(func.count(), where=[earlier])}
    failing = RequestLog.status >= FAILED_STATUS
    failed = {tuple(row[:width]): row[width] for row in grouped(func.count(), where=[recent, failing])}
    last = {tuple(row[:width]): row[width] for row in grouped(func.max(RequestLog.at), where=[])}
    found: dict[tuple[Any, ...], Usage] = {}
    for target, last_at in last.items():
        if any(part is None for part in target) or last_at is None:
            continue
        counts = daily.get(target, {})
        series = [counts.get(name, 0) for name in days]
        matching = [key == part for key, part in zip(keys, target, strict=True)]
        latencies = list(
            session.scalars(
                select(RequestLog.latency_ms)
                .where(scope, *matching, recent)
                .order_by(RequestLog.id.desc())
                .limit(LATENCY_SAMPLE)
            )
        )
        found[target] = Usage(
            days=days,
            daily=series,
            total=sum(series),
            previous=previous.get(target, 0),
            failed=failed.get(target, 0),
            last_at=last_at if last_at.tzinfo else last_at.replace(tzinfo=UTC),
            p50_ms=statistics.median(latencies) if latencies else None,
        )
    return found


@dataclass(frozen=True)
class UsageIndex:
    custom: dict[int, Usage]
    base: dict[str, Usage]
    versions: dict[tuple[int, int], Usage]


def usage_index(session: Session) -> UsageIndex:
    custom = usage_for(session, [RequestLog.minibrain_id], RequestLog.minibrain_id.is_not(None))
    base = usage_for(session, [RequestLog.model], RequestLog.minibrain_id.is_(None))
    versions = usage_for(session, [RequestLog.minibrain_id, RequestLog.version], RequestLog.minibrain_id.is_not(None))
    return UsageIndex(
        custom={target[0]: usage for target, usage in custom.items()},
        base={target[0]: usage for target, usage in base.items()},
        versions={(target[0], target[1]): usage for target, usage in versions.items()},
    )


def version_rows(
    minibrain: Minibrain,
    jobs: list[Job],
    version_usage: dict[tuple[int, int], Usage],
    base_hash: str | None = None,
    prices: DevicePrices | None = None,
) -> list[VersionRow]:
    rows: list[VersionRow] = []
    for version in sorted(minibrain.versions, key=lambda item: item.number, reverse=True):
        job = next((item for item in jobs if item.version_id == version.id), None)
        active = job is not None and job.status in ACTIVE_JOB_STATUSES
        latency = (version.metrics or {}).get("latency") or {}
        rows.append(
            VersionRow(
                number=version.number,
                kind=version.kind,
                status=version.status,
                live=minibrain.deployed and minibrain.current_version == version.number,
                accuracy=held_out_accuracy(version) if version.metrics else None,
                progress=running_progress(job) if job is not None and active else None,
                job_id=job.id if job is not None else None,
                error=job.error if job is not None and version.status == VersionStatus.FAILED else None,
                usage=version_usage.get((minibrain.id, version.number)),
                created_at=version.created_at,
                health=version_health(minibrain, version, base_hash),
                latency_p50_ms=latency.get("p50_ms"),
                latency_p95_ms=latency.get("p95_ms"),
                cost=cost_info(version.metrics, prices or DevicePrices()),
            )
        )
    return rows


def custom_availability(minibrain: Minibrain, store: ArtifactStore) -> Availability:
    trained = [v for v in minibrain.versions if v.kind == VersionKind.LORA and v.adapter_artifact_id is not None]
    if not trained:
        return Availability(state="none")
    present = all(store.has(v.adapter_artifact_id or "") for v in trained if v.status == VersionStatus.READY)
    return Availability(state="available" if present else "missing")


def stopping(teardown: Teardown | None) -> DeploymentState | None:
    if teardown is None:
        return None
    if teardown.kind == TeardownKind.UNDEPLOY:
        return "stopping" if teardown.status == TeardownStatus.RUNNING else "stop_failed"
    live = teardown.kind == TeardownKind.DELETE and teardown.detail.get("live")
    if live and teardown.status == TeardownStatus.RUNNING and teardown.step == TeardownStep.STOPPING:
        return "stopping"
    return None


def deployment(
    label_prefix: str, deployed: bool, health: str | None, versions: list[int], teardown: Teardown | None = None
) -> Deployment:
    halted = stopping(teardown)
    if halted is not None:
        label = STATE_LABELS[halted]
        return Deployment(state=halted, label=f"{label_prefix} · {label}" if label_prefix else label)
    if not deployed:
        return Deployment(state="not_deployed", label="Not deployed")
    state: DeploymentState = "running" if health == "running" else "unhealthy" if health == "unhealthy" else "starting"
    label = STATE_LABELS[state]
    return Deployment(state=state, label=f"{label_prefix} · {label}" if label_prefix else label, versions=versions)


def latest_moment(*moments: datetime | None) -> datetime:
    return max(moment for moment in moments if moment is not None)


def custom_row(
    minibrain: Minibrain,
    jobs: list[Job],
    store: ArtifactStore,
    health: EngineHealth,
    base_weights: int | None = None,
    usage: Usage | None = None,
    version_usage: dict[tuple[int, int], Usage] | None = None,
    base: tuple[str, Health | None, str | None, Availability | None] | None = None,
    prices: DevicePrices | None = None,
    teardown: tuple[Teardown | None, TeardownInfo | None] = (None, None),
) -> ModelRow:
    base_name, broken, base_hash, base_state = base or (minibrain.base_model, None, None, None)
    found, info = teardown
    availability = custom_availability(minibrain, store)
    if base_state is not None and base_state.state in ("downloading", "importing"):
        availability = base_state
    latest_version = max(minibrain.versions, key=lambda v: v.number, default=None)
    latest_job = jobs[0] if jobs else None
    current = minibrain.current_version
    ready = candidate(minibrain)
    updated = latest_moment(
        minibrain.created_at,
        minibrain.updated_at,
        latest_version.created_at if latest_version else None,
        latest_job.finished_at or latest_job.started_at or latest_job.created_at if latest_job else None,
    )
    return ModelRow(
        kind="custom",
        key=minibrain.slug,
        name=minibrain.name,
        description=minibrain.description,
        tags=list(minibrain.tags or []),
        base_model=minibrain.base_model,
        availability=availability,
        activity=custom_activity(minibrain, jobs),
        deployment=deployment(
            f"v{current}" if current is not None else "Base model",
            minibrain.deployed,
            health(minibrain.base_model) if minibrain.deployed else None,
            [current] if minibrain.deployed and current is not None else [],
            found,
        ),
        updated_at=updated,
        can_test=any(v.status == VersionStatus.READY for v in minibrain.versions),
        update_available=False,
        current_version=current,
        error=jobs[0].error if jobs and jobs[0].status == JobStatus.FAILED else None,
        versions=version_rows(minibrain, jobs, version_usage or {}, base_hash, prices),
        ready_version=ready.number if ready is not None else None,
        needed_bytes=needed_bytes(base_weights) if base_weights else None,
        stages=custom_stages(minibrain, jobs),
        accuracy=shown_accuracy(minibrain),
        usage=usage,
        health=custom_health(broken, base_name),
        teardown=info,
    )


def base_availability(model: Model, job: Job | None, settings: Settings) -> Availability:
    if model.status in (ModelStatus.DOWNLOADING, ModelStatus.IMPORTING):
        progress = running_progress(job) if job is not None else None
        state: AvailabilityState = "downloading" if model.status == ModelStatus.DOWNLOADING else "importing"
        return Availability(state=state, progress=progress, job_id=job.id if job else None)
    if model.status == ModelStatus.AVAILABLE:
        return Availability(state="available" if files_present(settings, model) else "missing")
    if model.status == ModelStatus.EVICTED:
        return restoring_availability(job)
    return Availability(state="not_downloaded", job_id=job.id if job else None)


def restoring(job: Job | None) -> bool:
    return job is not None and job.kind == JobKind.REPAIR and job.status in ACTIVE_JOB_STATUSES


def restoring_availability(job: Job | None) -> Availability:
    if job is None or not restoring(job):
        return Availability(state="evicted")
    state: AvailabilityState = "downloading" if job.params.get("source") == HUB else "importing"
    return Availability(state=state, progress=running_progress(job), job_id=job.id)


def restored_label(activity: Activity, job: Job | None) -> Activity:
    if job is None or not restoring(job):
        return activity
    verb = "Downloading again" if job.params.get("source") == HUB else "Re-importing"
    return activity.model_copy(update={"label": activity.label.replace("Repairing", verb)})


def base_activity(job: Job | None) -> Activity:
    if job is not None and job.status in ACTIVE_JOB_STATUSES:
        return active_activity(job)
    if job is not None and job.status == JobStatus.FAILED:
        return Activity(state="failed", label=FAILED_LABELS.get(job.kind, "Job failed"), kind=job.kind, job_id=job.id)
    return Activity(state="idle", label="No active jobs")


def base_row(
    model: Model,
    job: Job | None,
    settings: Settings,
    health: EngineHealth,
    usage: Usage | None = None,
    context: HealthContext | None = None,
    teardown: Teardown | None = None,
) -> ModelRow:
    availability = base_availability(model, job, settings)
    activity = base_activity(job)
    if model.status == ModelStatus.EVICTED:
        activity = restored_label(activity, job)
    problem = base_health(model, job, context or HealthContext(settings=settings, hub_ok=False))
    variant = model.variant
    latest = variant.latest_revision if variant is not None else None
    weights = sum(entry["size"] for entry in model.files if entry["path"].endswith(".safetensors"))
    updated = latest_moment(model.updated_at, job.finished_at or job.created_at if job else None)
    return ModelRow(
        kind="base",
        key=model.id,
        name=model.name,
        description=model.description,
        tags=list(model.tags or []),
        base_model=None,
        availability=availability,
        activity=activity,
        deployment=deployment("", model.deployed, health(model.id) if model.deployed else None, [], teardown),
        updated_at=updated,
        can_test=availability.state == "available" and problem is None,
        update_available=latest is not None and model.revision is not None and latest != model.revision,
        current_version=None,
        ready_version=None,
        needed_bytes=needed_bytes(weights) if weights else None,
        publisher=variant.model.provider if variant is not None else publisher_of(model.repo),
        error=model.error or (job.error if job is not None and job.status == JobStatus.FAILED else None),
        size_bytes=model.size_bytes or None,
        usage=usage,
        revision=model.revision,
        health=problem,
        catalog_id=model.catalog_id,
        pinned=model.pinned,
        last_used_at=model.last_used_at or model.created_at,
        teardown=teardown_info(teardown),
    )


def jobs_by(session: Session) -> tuple[dict[int, list[Job]], dict[str, Job]]:
    by_minibrain: dict[int, list[Job]] = {}
    by_model: dict[str, Job] = {}
    for job in session.scalars(select(Job).order_by(Job.id.desc())):
        if job.minibrain_id is not None:
            by_minibrain.setdefault(job.minibrain_id, []).append(job)
        if job.model_id is not None and job.model_id not in by_model:
            by_model[job.model_id] = job
    return by_minibrain, by_model


def base_weights(session: Session) -> dict[str, int]:
    weights: dict[str, int] = {}
    for variant in session.scalars(select(CatalogVariant).where(CatalogVariant.position == 0)):
        weights[variant.catalog_id] = variant.weights_bytes
    for model in session.scalars(select(Model)):
        weights[model.id] = sum(entry["size"] for entry in model.files if entry["path"].endswith(".safetensors"))
    return weights


def all_rows(
    session: Session, settings: Settings, store: ArtifactStore, health: EngineHealth, context: HealthContext
) -> list[ModelRow]:
    by_minibrain, by_model = jobs_by(session)
    weights = base_weights(session)
    usage = usage_index(session)
    prices = load_prices(session)
    teardowns = list(session.scalars(select(Teardown)))
    parents = {teardown.id: teardown.name for teardown in teardowns}
    custom_teardowns = {item.minibrain_id: item for item in teardowns if item.minibrain_id is not None}
    base_teardowns = {item.model_id: item for item in teardowns if item.model_id is not None}
    models = list(session.scalars(select(Model)))
    base_rows = [
        base_row(
            model,
            by_model.get(model.id),
            settings,
            health,
            usage.base.get(model.id),
            context,
            base_teardowns.get(model.id),
        )
        for model in models
    ]

    def custom_teardown(minibrain: Minibrain) -> tuple[Teardown | None, TeardownInfo | None]:
        found = custom_teardowns.get(minibrain.id)
        part_of = parents.get(found.parent_id) if found is not None and found.parent_id is not None else None
        return found, teardown_info(found, part_of)

    bases = {
        model.id: (
            model.name,
            row.health,
            content_hash(model.files) if model.status == ModelStatus.AVAILABLE else None,
            row.availability,
        )
        for model, row in zip(models, base_rows, strict=True)
    }
    rows = [
        custom_row(
            minibrain,
            by_minibrain.get(minibrain.id, []),
            store,
            health,
            weights.get(minibrain.base_model),
            usage.custom.get(minibrain.id),
            usage.versions,
            bases.get(minibrain.base_model),
            prices,
            custom_teardown(minibrain),
        )
        for minibrain in session.scalars(select(Minibrain))
    ]
    rows += base_rows
    custom_keys = dict(
        session.execute(
            select(KeyScope.minibrain_id, func.count())
            .where(KeyScope.minibrain_id.is_not(None))
            .group_by(KeyScope.minibrain_id)
        ).all()
    )
    base_keys = dict(
        session.execute(
            select(KeyScope.model_id, func.count()).where(KeyScope.model_id.is_not(None)).group_by(KeyScope.model_id)
        ).all()
    )
    slugs = dict(session.execute(select(Minibrain.slug, Minibrain.id)).all())
    rows = [
        row.model_copy(
            update={
                "key_count": custom_keys.get(slugs.get(row.key), 0)
                if row.kind == "custom"
                else base_keys.get(row.key, 0)
            }
        )
        for row in rows
    ]
    return sorted(rows, key=lambda row: row.updated_at, reverse=True)


def model_job(session: Session, model_id: str) -> Job | None:
    return session.scalar(select(Job).where(Job.model_id == model_id).order_by(Job.id.desc()).limit(1))
