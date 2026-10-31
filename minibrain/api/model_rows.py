from collections.abc import Callable
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.api.schemas import Activity, Availability, AvailabilityState, Deployment, DeploymentState, ModelRow
from minibrain.artifacts import ArtifactStore
from minibrain.models.hardware import needed_bytes
from minibrain.models.registry import files_present
from minibrain.registry.models import (
    ACTIVE_JOB_STATUSES,
    Job,
    JobKind,
    JobStatus,
    Minibrain,
    Model,
    ModelStatus,
    Version,
    VersionKind,
    VersionStatus,
)
from minibrain.settings import Settings

FAILED_LABELS: dict[str, str] = {
    JobKind.TRAIN: "Training failed",
    JobKind.EVAL: "Scoring failed",
    JobKind.PREPARE: "Dataset build failed",
    JobKind.DOWNLOAD: "Download failed",
    JobKind.IMPORT: "Import failed",
}
STATE_LABELS = {"running": "Running", "starting": "Starting", "unhealthy": "Unhealthy"}


Health = Callable[[str], str | None]


def running_progress(job: Job) -> float | None:
    return job.progress if job.status == JobStatus.RUNNING and job.progress > 0 else None


def version_label(job: Job) -> str:
    number = job.version.number if job.version is not None else None
    if job.kind == JobKind.PREPARE:
        return "Building dataset"
    verb = "training" if job.kind == JobKind.TRAIN else "evaluating"
    return f"v{number} {verb}" if number is not None else verb.capitalize()


def active_activity(job: Job) -> Activity:
    label = (
        version_label(job)
        if job.kind not in (JobKind.DOWNLOAD, JobKind.IMPORT)
        else ("Downloading" if job.kind == JobKind.DOWNLOAD else "Importing")
    )
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
    if not minibrain.snapshots:
        return Activity(state="needs_examples", label="Needs examples")
    return Activity(state="idle", label="No active jobs")


def custom_availability(minibrain: Minibrain, store: ArtifactStore) -> Availability:
    trained = [v for v in minibrain.versions if v.kind == VersionKind.LORA and v.adapter_artifact_id is not None]
    if not trained:
        return Availability(state="none")
    present = all(store.has(v.adapter_artifact_id or "") for v in trained if v.status == VersionStatus.READY)
    return Availability(state="available" if present else "missing")


def deployment(label_prefix: str, deployed: bool, health: str | None, versions: list[int]) -> Deployment:
    if not deployed:
        return Deployment(state="not_deployed", label="Not deployed")
    state: DeploymentState = "running" if health == "running" else "unhealthy" if health == "unhealthy" else "starting"
    label = STATE_LABELS[state]
    return Deployment(state=state, label=f"{label_prefix} · {label}" if label_prefix else label, versions=versions)


def latest_moment(*moments: datetime | None) -> datetime:
    return max(moment for moment in moments if moment is not None)


def custom_row(minibrain: Minibrain, jobs: list[Job], store: ArtifactStore, health: Health) -> ModelRow:
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
        archived=minibrain.archived_at is not None,
        base_model=minibrain.base_model,
        availability=custom_availability(minibrain, store),
        activity=custom_activity(minibrain, jobs),
        deployment=deployment(
            f"v{current}" if current is not None else "",
            current is not None,
            health(minibrain.base_model) if current is not None else None,
            [current] if current is not None else [],
        ),
        updated_at=updated,
        trainable=False,
        can_test=any(v.status == VersionStatus.READY for v in minibrain.versions),
        update_available=False,
        current_version=current,
        ready_version=ready.number if ready is not None else None,
        needed_bytes=None,
    )


def base_availability(model: Model, job: Job | None, settings: Settings) -> Availability:
    if model.status in (ModelStatus.DOWNLOADING, ModelStatus.IMPORTING):
        progress = running_progress(job) if job is not None else None
        state: AvailabilityState = "downloading" if model.status == ModelStatus.DOWNLOADING else "importing"
        return Availability(state=state, progress=progress, job_id=job.id if job else None)
    if model.status == ModelStatus.AVAILABLE:
        return Availability(state="available" if files_present(settings, model) else "missing")
    return Availability(state="not_downloaded", job_id=job.id if job else None)


def base_activity(job: Job | None) -> Activity:
    if job is not None and job.status in ACTIVE_JOB_STATUSES:
        return active_activity(job)
    if job is not None and job.status == JobStatus.FAILED:
        return Activity(state="failed", label=FAILED_LABELS.get(job.kind, "Job failed"), kind=job.kind, job_id=job.id)
    return Activity(state="idle", label="No active jobs")


def base_row(model: Model, job: Job | None, settings: Settings, health: Health) -> ModelRow:
    availability = base_availability(model, job, settings)
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
        archived=model.archived_at is not None,
        base_model=None,
        availability=availability,
        activity=base_activity(job),
        deployment=deployment("", model.deployed, health(model.id) if model.deployed else None, []),
        updated_at=updated,
        trainable=model.trainable and availability.state == "available",
        can_test=availability.state == "available",
        update_available=latest is not None and model.revision is not None and latest != model.revision,
        current_version=None,
        ready_version=None,
        needed_bytes=needed_bytes(weights) if weights else None,
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


def all_rows(session: Session, settings: Settings, store: ArtifactStore, health: Health) -> list[ModelRow]:
    by_minibrain, by_model = jobs_by(session)
    rows = [
        custom_row(minibrain, by_minibrain.get(minibrain.id, []), store, health)
        for minibrain in session.scalars(select(Minibrain))
    ]
    rows += [base_row(model, by_model.get(model.id), settings, health) for model in session.scalars(select(Model))]
    return sorted(rows, key=lambda row: row.updated_at, reverse=True)


def model_job(session: Session, model_id: str) -> Job | None:
    return session.scalar(select(Job).where(Job.model_id == model_id).order_by(Job.id.desc()).limit(1))
