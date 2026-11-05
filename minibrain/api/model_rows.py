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
    DecisionInfo,
    Deployment,
    DeploymentState,
    Health,
    ModelRow,
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
from minibrain.registry.models import (
    ACTIVE_JOB_STATUSES,
    BaseModel,
    BaseModelStatus,
    CatalogVariant,
    Job,
    JobKind,
    JobStatus,
    KeyScope,
    Model,
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
from minibrain.registry.service import latest_snapshot
from minibrain.settings import Settings
from minibrain.tasks.service import decision, held_out_score, version_metric

FAILED_LABELS: dict[str, str] = {
    JobKind.TRAIN: "Training failed",
    JobKind.EVAL: "Scoring failed",
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
FETCHING = "fetching"
FETCHING_LABEL = "Fetching weights"
USAGE_DAYS = 7
FAILED_STATUS = 500
LATENCY_SAMPLE = 2000


EngineHealth = Callable[[str], str | None]


def running_progress(job: Job) -> float | None:
    return job.progress if job.status == JobStatus.RUNNING and job.progress > 0 else None


def version_label(job: Job) -> str:
    number = job.version.number if job.version is not None else None
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


def candidate(model: Model) -> Version | None:
    current = model.current_version if model.current_version is not None else -1
    ready = [v for v in model.versions if v.status == VersionStatus.READY and v.number > current]
    return max(ready, key=lambda v: v.number, default=None)


def custom_activity(model: Model, jobs: list[Job]) -> Activity:
    active = next((job for job in jobs if job.status in ACTIVE_JOB_STATUSES), None)
    if active is not None:
        return active_activity(active)
    latest = jobs[0] if jobs else None
    if latest is not None and latest.status == JobStatus.FAILED:
        version = latest.version.number if latest.version is not None else None
        label = FAILED_LABELS.get(latest.kind, "Job failed")
        return Activity(state="failed", label=label, kind=latest.kind, version=version, job_id=latest.id)
    ready = candidate(model)
    if ready is not None:
        return Activity(state="ready", label=f"v{ready.number} ready", version=ready.number)
    if latest_snapshot(model) is None:
        return Activity(state="needs_examples", label="Needs examples")
    return Activity(state="idle", label="No active jobs")


def scored(model: Model) -> list[Version]:
    return [v for v in model.versions if v.status == VersionStatus.READY and v.metrics]


def promotion_of(model: Model, version: Version) -> DecisionInfo | None:
    if version.status != VersionStatus.READY:
        return None
    return DecisionInfo.model_validate(decision(model, version).as_dict())


def shown_version(model: Model) -> Version | None:
    versions = scored(model)
    current = next((v for v in versions if v.number == model.current_version), None)
    return current or max(versions, key=lambda v: v.number, default=None)


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
    custom = usage_for(session, [RequestLog.model_id], RequestLog.model_id.is_not(None))
    added = select(BaseModel.created_at).where(BaseModel.id == RequestLog.model).scalar_subquery()
    base = usage_for(session, [RequestLog.model], RequestLog.model_id.is_(None) & (RequestLog.at >= added))
    versions = usage_for(session, [RequestLog.model_id, RequestLog.version], RequestLog.model_id.is_not(None))
    return UsageIndex(
        custom={target[0]: usage for target, usage in custom.items()},
        base={target[0]: usage for target, usage in base.items()},
        versions={(target[0], target[1]): usage for target, usage in versions.items()},
    )


def version_rows(
    model: Model,
    jobs: list[Job],
    version_usage: dict[tuple[int, int], Usage],
    base_hash: str | None = None,
    prices: DevicePrices | None = None,
) -> list[VersionRow]:
    rows: list[VersionRow] = []
    for version in sorted(model.versions, key=lambda item: item.number, reverse=True):
        job = next((item for item in jobs if item.version_id == version.id), None)
        active = job is not None and job.status in ACTIVE_JOB_STATUSES
        latency = (version.metrics or {}).get("latency") or {}
        rows.append(
            VersionRow(
                number=version.number,
                kind=version.kind,
                status=version.status,
                live=model.deployed and model.current_version == version.number,
                score=held_out_score(version),
                metric=version_metric(version),
                promotion=promotion_of(model, version),
                was_live=version.live_at is not None,
                progress=running_progress(job) if job is not None and active else None,
                job_id=job.id if job is not None else None,
                error=job.error if job is not None and version.status == VersionStatus.FAILED else None,
                usage=version_usage.get((model.id, version.number)),
                created_at=version.created_at,
                health=version_health(model, version, base_hash),
                latency_p50_ms=latency.get("p50_ms"),
                latency_p95_ms=latency.get("p95_ms"),
                cost=cost_info(version.metrics, prices or DevicePrices()),
            )
        )
    return rows


def custom_availability(model: Model, store: ArtifactStore) -> Availability:
    trained = [v for v in model.versions if v.kind == VersionKind.LORA and v.adapter_artifact_id is not None]
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
    label = FETCHING_LABEL if health == FETCHING else STATE_LABELS[state]
    return Deployment(state=state, label=f"{label_prefix} · {label}" if label_prefix else label, versions=versions)


def latest_moment(*moments: datetime | None) -> datetime:
    return max(moment for moment in moments if moment is not None)


def custom_row(
    model: Model,
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
    base_name, broken, base_hash, base_state = base or (model.base_model, None, None, None)
    found, info = teardown
    availability = custom_availability(model, store)
    if base_state is not None and base_state.state in ("downloading", "importing"):
        availability = base_state
    latest_version = max(model.versions, key=lambda v: v.number, default=None)
    latest_job = jobs[0] if jobs else None
    current = model.current_version
    ready = candidate(model)
    updated = latest_moment(
        model.created_at,
        model.updated_at,
        latest_version.created_at if latest_version else None,
        latest_job.finished_at or latest_job.started_at or latest_job.created_at if latest_job else None,
    )
    shown = shown_version(model)
    return ModelRow(
        kind="custom",
        key=model.slug,
        name=model.name,
        description=model.description,
        tags=list(model.tags or []),
        base_model=model.base_model,
        availability=availability,
        activity=custom_activity(model, jobs),
        deployment=deployment(
            f"v{current}" if current is not None else "Base model",
            model.deployed,
            health(model.base_model) if model.deployed else None,
            [current] if model.deployed and current is not None else [],
            found,
        ),
        updated_at=updated,
        can_test=any(v.status == VersionStatus.READY for v in model.versions),
        update_available=False,
        current_version=current,
        error=jobs[0].error if jobs and jobs[0].status == JobStatus.FAILED else None,
        versions=version_rows(model, jobs, version_usage or {}, base_hash, prices),
        ready_version=ready.number if ready is not None else None,
        needed_bytes=needed_bytes(base_weights) if base_weights else None,
        score=held_out_score(shown) if shown is not None else None,
        metric=version_metric(shown) if shown is not None else None,
        usage=usage,
        health=custom_health(broken, base_name),
        teardown=info,
    )


def base_availability(model: BaseModel, job: Job | None, settings: Settings) -> Availability:
    if model.status in (BaseModelStatus.DOWNLOADING, BaseModelStatus.IMPORTING):
        progress = running_progress(job) if job is not None else None
        state: AvailabilityState = "downloading" if model.status == BaseModelStatus.DOWNLOADING else "importing"
        return Availability(state=state, progress=progress, job_id=job.id if job else None)
    if model.status == BaseModelStatus.AVAILABLE:
        return Availability(state="available" if files_present(settings, model) else "missing")
    return Availability(state="not_downloaded", job_id=job.id if job else None)


def base_activity(job: Job | None) -> Activity:
    if job is not None and job.status in ACTIVE_JOB_STATUSES:
        return active_activity(job)
    if job is not None and job.status == JobStatus.FAILED:
        return Activity(state="failed", label=FAILED_LABELS.get(job.kind, "Job failed"), kind=job.kind, job_id=job.id)
    return Activity(state="idle", label="No active jobs")


def base_row(
    model: BaseModel,
    job: Job | None,
    settings: Settings,
    health: EngineHealth,
    usage: Usage | None = None,
    context: HealthContext | None = None,
    teardown: Teardown | None = None,
) -> ModelRow:
    availability = base_availability(model, job, settings)
    activity = base_activity(job)
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
        last_used_at=model.last_used_at or model.created_at,
        teardown=teardown_info(teardown),
    )


def jobs_by(session: Session) -> tuple[dict[int, list[Job]], dict[str, Job]]:
    by_model: dict[int, list[Job]] = {}
    by_base: dict[str, Job] = {}
    for job in session.scalars(select(Job).order_by(Job.id.desc())):
        if job.model_id is not None:
            by_model.setdefault(job.model_id, []).append(job)
        if job.base_model_id is not None and job.base_model_id not in by_base:
            by_base[job.base_model_id] = job
    return by_model, by_base


def base_weights(session: Session) -> dict[str, int]:
    weights: dict[str, int] = {}
    for variant in session.scalars(select(CatalogVariant).where(CatalogVariant.position == 0)):
        weights[variant.catalog_id] = variant.weights_bytes
    for model in session.scalars(select(BaseModel)):
        weights[model.id] = sum(entry["size"] for entry in model.files if entry["path"].endswith(".safetensors"))
    return weights


def all_rows(
    session: Session, settings: Settings, store: ArtifactStore, health: EngineHealth, context: HealthContext
) -> list[ModelRow]:
    by_model, by_base = jobs_by(session)
    weights = base_weights(session)
    usage = usage_index(session)
    prices = load_prices(session)
    teardowns = list(session.scalars(select(Teardown)))
    parents = {teardown.id: teardown.name for teardown in teardowns}
    custom_teardowns = {item.model_id: item for item in teardowns if item.model_id is not None}
    base_teardowns = {item.base_model_id: item for item in teardowns if item.base_model_id is not None}
    bases_found = list(session.scalars(select(BaseModel)))
    base_rows = [
        base_row(
            base,
            by_base.get(base.id),
            settings,
            health,
            usage.base.get(base.id),
            context,
            base_teardowns.get(base.id),
        )
        for base in bases_found
    ]

    def custom_teardown(model: Model) -> tuple[Teardown | None, TeardownInfo | None]:
        found = custom_teardowns.get(model.id)
        part_of = parents.get(found.parent_id) if found is not None and found.parent_id is not None else None
        return found, teardown_info(found, part_of)

    bases = {
        base.id: (
            base.name,
            row.health,
            content_hash(base.files) if base.status == BaseModelStatus.AVAILABLE else None,
            row.availability,
        )
        for base, row in zip(bases_found, base_rows, strict=True)
    }
    rows = [
        custom_row(
            model,
            by_model.get(model.id, []),
            store,
            health,
            weights.get(model.base_model),
            usage.custom.get(model.id),
            usage.versions,
            bases.get(model.base_model),
            prices,
            custom_teardown(model),
        )
        for model in session.scalars(select(Model))
    ]
    rows += base_rows
    custom_keys = dict(
        session.execute(
            select(KeyScope.model_id, func.count()).where(KeyScope.model_id.is_not(None)).group_by(KeyScope.model_id)
        ).all()
    )
    base_keys = dict(
        session.execute(
            select(KeyScope.base_model_id, func.count())
            .where(KeyScope.base_model_id.is_not(None))
            .group_by(KeyScope.base_model_id)
        ).all()
    )
    slugs = dict(session.execute(select(Model.slug, Model.id)).all())
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


def model_job(session: Session, base_model_id: str) -> Job | None:
    return session.scalar(select(Job).where(Job.base_model_id == base_model_id).order_by(Job.id.desc()).limit(1))
