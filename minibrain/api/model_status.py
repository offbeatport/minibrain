import math
from datetime import timedelta
from typing import Literal

from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.api.model_health import HealthContext, base_health
from minibrain.api.model_rows import model_job
from minibrain.api.model_traffic import Subject, overall, subject_of, usual_error_rate
from minibrain.api.request_logs import aware
from minibrain.api.views import teardown_label
from minibrain.models.handover import moving_to, serving_pool
from minibrain.models.hardware import LOCAL_POOL
from minibrain.registry.compute import live_engines
from minibrain.registry.models import (
    ACTIVE_JOB_STATUSES,
    BaseModelStatus,
    Job,
    JobKind,
    Model,
    RequestLog,
    TeardownStatus,
    Version,
    VersionKind,
    VersionStatus,
    now,
)
from minibrain.registry.models import BaseModel as BaseRow
from minibrain.registry.service import latest_dataset_version
from minibrain.settings import Settings
from minibrain.tasks.rebase import ServeOnly
from minibrain.tasks.service import decision, held_out_score, live_version, serving_base, upcoming_version_number

StatusKind = Literal[
    "promote",
    "deploy",
    "open_job",
    "retry_job",
    "open_monitoring",
    "review_feedback",
    "add_data",
    "train",
    "switch_base",
    "create_custom",
]
StatusTone = Literal["success", "info", "warning", "destructive", "neutral"]

ERROR_FLOOR = 0.02
ERROR_FACTOR = 3
ERROR_MINIMUM = 20
STARTED_SHARE = 0.02
TRAINING_KINDS = (JobKind.TRAIN, JobKind.EVAL)
TRANSFER_KINDS = {JobKind.DOWNLOAD: "Downloading", JobKind.IMPORT: "Importing"}


class StatusAction(BaseModel):
    kind: StatusKind
    label: str
    version: int | None = None
    job_id: int | None = None
    job_kind: str | None = None
    base: str | None = None
    everyone: bool = Field(default=False, description="Viewers may follow it too; the others need the Builder role.")


class ModelStatus(BaseModel):
    tone: StatusTone
    text: str
    action: StatusAction | None


def baseline(version: Version) -> bool:
    return version.kind == VersionKind.PROMPT and version.number == 0


def passing_candidate(model: Model) -> int | None:
    current = model.current_version if model.deployed and model.current_version is not None else -1
    ready = [
        v
        for v in model.versions
        if v.status == VersionStatus.READY
        and v.number > current
        and v.base_model == model.base_model
        and not baseline(v)
    ]
    passing = [v for v in ready if decision(model, v).passed or (v.live_at is not None and beats_live(model, v))]
    best = max(passing, key=lambda v: v.number, default=None)
    return best.number if best is not None else None


def beats_live(model: Model, version: Version) -> bool:
    live = live_version(model)
    live_score = held_out_score(live) if live is not None else None
    if live_score is None:
        return True
    score = held_out_score(version)
    return score is not None and score > live_score


def rows_text(count: int) -> str:
    return f"{count} feedback {'row' if count == 1 else 'rows'} to review"


def share(value: float) -> str:
    return f"{value * 100:.1f}%"


def replicas_text(count: int) -> str:
    return f"{count} {'replica' if count == 1 else 'replicas'}"


def replica_count(session: Session, base: str, pool: str | None) -> int:
    where = pool or LOCAL_POOL
    return sum(1 for replica in live_engines(session) if replica.base_model == base and replica.pool == where)


def pool_part(pool: str | None) -> str:
    return f" on {pool}" if pool and pool != LOCAL_POOL else ""


def errors_status(session: Session, subject: Subject) -> ModelStatus | None:
    until = now()
    usual = usual_error_rate(session, subject.scope, until)
    if usual is None:
        return None
    recent = overall(session, [subject.scope, RequestLog.at >= until - timedelta(days=1), RequestLog.at < until])
    rate = recent["error_rate"]
    if recent["requests"] < ERROR_MINIMUM or rate is None or rate < ERROR_FLOOR or rate < usual * ERROR_FACTOR:
        return None
    usually = share(usual) if usual > 0 else "none"
    return ModelStatus(
        tone="warning",
        text=f"Errors {share(rate)} in the last 24 hours (usually {usually})",
        action=StatusAction(kind="open_monitoring", label="Open monitoring", everyone=True),
    )


def latest_job(session: Session, version: Version) -> Job | None:
    query = select(Job).where(Job.version_id == version.id).order_by(Job.id.desc()).limit(1)
    return session.scalar(query)


def failed_status(session: Session, model: Model) -> ModelStatus | None:
    newest = max(model.versions, key=lambda v: v.number, default=None)
    if newest is None or newest.status != VersionStatus.FAILED:
        return None
    job = latest_job(session, newest)
    memory = job is not None and "memory" in (job.error or "").lower()
    action = None if job is None else StatusAction(kind="retry_job", label="Retry", job_id=job.id, job_kind=job.kind)
    return ModelStatus(
        tone="destructive", text=f"v{newest.number} failed{': out of memory' if memory else ''}", action=action
    )


def points(value: float) -> str:
    return f"{value * 100:+.1f}"


def promote_status(model: Model) -> ModelStatus | None:
    number = passing_candidate(model)
    if number is None:
        return None
    version = next(v for v in model.versions if v.number == number)
    score = held_out_score(version)
    live = live_version(model)
    live_score = held_out_score(live) if live is not None else None
    if live is not None and score is not None and live_score is not None:
        text = f"v{number} beats live by {points(score - live_score)}"
    else:
        text = f"v{number} ready · {share(score)}" if score is not None else f"v{number} ready"
    return ModelStatus(
        tone="info", text=text, action=StatusAction(kind="promote", label=f"Deploy v{number}", version=number)
    )


def time_left(job: Job) -> str | None:
    if job.started_at is None or job.progress < STARTED_SHARE:
        return None
    elapsed = (now() - aware(job.started_at)).total_seconds()
    minutes = max(1, math.ceil(elapsed * (1 - job.progress) / job.progress / 60))
    if minutes < 60:
        return f"{minutes} min left"
    hours, rest = divmod(minutes, 60)
    return f"{hours} h {rest} min left" if rest else f"{hours} h left"


def job_status(session: Session, model: Model) -> ModelStatus | None:
    query = (
        select(Job)
        .where(Job.model_id == model.id, Job.status.in_(ACTIVE_JOB_STATUSES), Job.kind.in_(TRAINING_KINDS))
        .order_by(Job.id.desc())
        .limit(1)
    )
    job = session.scalar(query)
    if job is None:
        return None
    version = session.get(Version, job.version_id) if job.version_id is not None else None
    verb = "Training" if job.kind == JobKind.TRAIN else "Scoring"
    parts = [f"{verb} v{version.number}" if version is not None else verb]
    if job.started_at is None:
        parts.append("queued")
    else:
        parts.append(f"{round(job.progress * 100)}%")
        left = time_left(job)
        if left:
            parts.append(left)
    action = StatusAction(kind="open_job", label="View", job_id=job.id, job_kind=job.kind, everyone=True)
    return ModelStatus(tone="info", text=" · ".join(parts), action=action)


def neutral(text: str, action: StatusAction | None) -> ModelStatus:
    return ModelStatus(tone="neutral", text=text, action=action)


def trained(model: Model) -> bool:
    return any(v.kind == VersionKind.LORA and v.status == VersionStatus.READY for v in model.versions)


def settled(session: Session, model: Model) -> ModelStatus:
    live = live_version(model)
    pool = serving_pool(model)
    serving = replicas_text(replica_count(session, serving_base(model), pool))
    where = f"v{live.number}" if live is not None else "base weights"
    return ModelStatus(tone="success", text=f"Live: {where}{pool_part(pool)} · {serving}", action=None)


def move_status(row: Model | BaseRow) -> ModelStatus | None:
    if not row.deployed:
        return None
    target = moving_to(row)
    if target is not None:
        return ModelStatus(
            tone="info", text=f"Moving to {target} · {serving_pool(row)} serves until it is ready", action=None
        )
    if row.move_failure:
        return ModelStatus(tone="warning", text=row.move_failure, action=StatusAction(kind="deploy", label="Deploy"))
    return None


def custom_status(session: Session, model: Model, pending: int, limit: ServeOnly | None) -> ModelStatus:
    teardown = model.teardown
    if teardown is not None and teardown.status == TeardownStatus.FAILED:
        return ModelStatus(tone="destructive", text=teardown_label(teardown), action=None)
    found = (
        move_status(model)
        or errors_status(session, subject_of(session, model.slug))
        or failed_status(session, model)
        or promote_status(model)
        or job_status(session, model)
    )
    if found is not None:
        return found
    if pending > 0:
        return neutral(rows_text(pending), StatusAction(kind="review_feedback", label="Review"))
    if latest_dataset_version(model) is None:
        return neutral("No data yet", StatusAction(kind="add_data", label="Add data"))
    if limit is None and not trained(model):
        upcoming = upcoming_version_number(model)
        return neutral("Ready to train", StatusAction(kind="train", label=f"Train v{upcoming}", version=upcoming))
    if not model.deployed:
        return neutral("Not deployed", StatusAction(kind="deploy", label="Deploy"))
    if limit is not None and limit.target is not None:
        move = StatusAction(kind="switch_base", label=f"Move to {limit.target.name} to train", base=limit.target.key)
        return neutral(f"{limit.format.upper()} weights can't be trained", move)
    return settled(session, model)


def transfer_status(session: Session, base: BaseRow) -> ModelStatus | None:
    job = model_job(session, base.id)
    if job is None or job.status not in ACTIVE_JOB_STATUSES or job.kind not in TRANSFER_KINDS:
        return None
    action = StatusAction(kind="open_job", label="View", job_id=job.id, job_kind=job.kind, everyone=True)
    text = f"{TRANSFER_KINDS[JobKind(job.kind)]} {round(job.progress * 100)}%"
    return ModelStatus(tone="info", text=text, action=action)


def base_status(session: Session, settings: Settings, base: BaseRow) -> ModelStatus:
    teardown = base.teardown
    if teardown is not None and teardown.status == TeardownStatus.FAILED:
        return ModelStatus(tone="destructive", text=teardown_label(teardown), action=None)
    health = base_health(base, model_job(session, base.id), HealthContext(settings=settings, hub_ok=False))
    if health is not None:
        return ModelStatus(tone="destructive", text=health.label, action=None)
    found = move_status(base) or errors_status(session, subject_of(session, base.id)) or transfer_status(session, base)
    if found is not None:
        return found
    if base.status != BaseModelStatus.AVAILABLE:
        return neutral("Not ready", None)
    if not base.deployed:
        return neutral("Not deployed", StatusAction(kind="deploy", label="Deploy"))
    pool = serving_pool(base)
    count = replica_count(session, base.id, pool)
    return ModelStatus(
        tone="success",
        text=f"Live{pool_part(pool)} · {replicas_text(count)}",
        action=StatusAction(kind="create_custom", label="Add a model on it"),
    )
