from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from minibrain.api.access import viewer
from minibrain.api.deps import SessionDep, SettingsDep
from minibrain.api.model_activity import CREATING
from minibrain.api.model_status import ModelStatus, base_status, custom_status, passing_candidate, rows_text, trained
from minibrain.api.overview import Identity, model_rows, series_points
from minibrain.api.request_logs import model_match
from minibrain.api.schemas import ModelAvatar
from minibrain.api.views import avatar_of
from minibrain.data import feedback as feedback_store
from minibrain.registry.models import (
    ACTIVE_JOB_STATUSES,
    AuditEvent,
    BaseModelStatus,
    Feedback,
    FeedbackStatus,
    Job,
    Model,
    RequestLog,
    now,
)
from minibrain.registry.models import BaseModel as BaseRow
from minibrain.registry.service import latest_dataset_version, no_model
from minibrain.settings import Settings
from minibrain.tasks.rebase import ServeOnly, serve_only
from minibrain.tasks.service import live_version

router = APIRouter(prefix="/api")

DAYS = 7
DAY = timedelta(days=1)

NextKind = Literal["promote", "deploy", "review_feedback", "add_data", "train", "switch_base", "create_custom"]


class TrafficDay(BaseModel):
    day: datetime
    requests: int
    errors: int


class ModelTraffic(BaseModel):
    since: datetime
    until: datetime
    days: list[TrafficDay]
    requests: int
    errors: int
    error_rate: float | None
    p95_ms: float | None


class NextAction(BaseModel):
    kind: NextKind
    label: str
    version: int | None = None
    count: int | None = None
    base: str | None = Field(default=None, description="The base to switch to, for switch_base.")


class ModelPage(BaseModel):
    kind: Literal["base", "custom"]
    key: str
    name: str
    avatar: ModelAvatar | None = None
    traffic: ModelTraffic = Field(description="Requests per day, p95 latency and error rate over the last 7 days.")
    next: NextAction | None = Field(description="The one step the model page suggests, or none while busy.")
    status: ModelStatus = Field(description="One line on the model's state, broken first, with at most one action.")
    created_at: datetime | None = None
    created_by: str | None = Field(default=None, description="Who created, duplicated, downloaded or imported it.")


def day_edges(until: datetime) -> list[datetime]:
    today = until.astimezone(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    return [today - DAY * (DAYS - 1 - index) for index in range(DAYS)]


def traffic(session: Session, name: str, identity: Identity) -> ModelTraffic:
    until = now()
    edges = day_edges(until)
    where = [RequestLog.at >= edges[0], RequestLog.at < until, model_match([name])]
    overall = dict(model_rows(session, where)).get(identity)
    points = {point.bucket: point for point in series_points(session, where, [identity], edges) if point.series == 0}
    days = [
        TrafficDay(
            day=edge,
            requests=points[index].requests if index in points else 0,
            errors=points[index].errors if index in points else 0,
        )
        for index, edge in enumerate(edges)
    ]
    total = overall.total if overall else 0
    errors = overall.errors if overall else 0
    return ModelTraffic(
        since=edges[0],
        until=until,
        days=days,
        requests=total,
        errors=errors,
        error_rate=errors / total if total else None,
        p95_ms=overall.p95 if overall else None,
    )


def busy(session: Session, model: Model) -> bool:
    active = select(func.count()).select_from(Job).where(Job.model_id == model.id, Job.status.in_(ACTIVE_JOB_STATUSES))
    return bool(session.scalar(active))


def train_next(model: Model, limit: ServeOnly | None) -> NextAction | None:
    if limit is None:
        upcoming = max((v.number for v in model.versions), default=0) + 1
        return NextAction(kind="train", label=f"Train v{upcoming}", version=upcoming)
    if limit.target is None:
        return None
    return NextAction(kind="switch_base", label=f"Move to {limit.target.name} to train", base=limit.target.key)


def undeployed_next(model: Model, limit: ServeOnly | None) -> NextAction | None:
    if latest_dataset_version(model) is None:
        return NextAction(kind="add_data", label="Add training data")
    if limit is None and not trained(model):
        return train_next(model, limit)
    return NextAction(kind="deploy", label="Deploy")


def custom_next(model: Model, pending: int, working: bool, limit: ServeOnly | None = None) -> NextAction | None:
    if model.teardown is not None or working:
        return None
    candidate = passing_candidate(model)
    if candidate is not None:
        label = f"v{candidate} beats live, deploy it" if live_version(model) else f"Deploy v{candidate}"
        return NextAction(kind="promote", label=label, version=candidate)
    if not model.deployed:
        return undeployed_next(model, limit)
    if pending > 0:
        return NextAction(kind="review_feedback", label=rows_text(pending), count=pending)
    if latest_dataset_version(model) is None:
        return NextAction(kind="add_data", label="Add training data")
    return train_next(model, limit)


def base_next(model: BaseRow) -> NextAction | None:
    if model.teardown is not None or model.health or model.status != BaseModelStatus.AVAILABLE:
        return None
    if not model.deployed:
        return NextAction(kind="deploy", label="Deploy")
    return NextAction(kind="create_custom", label="Create a custom model from it")


def creator(session: Session, target: str) -> str | None:
    query = (
        select(AuditEvent.actor)
        .where(AuditEvent.target == target, AuditEvent.action.in_(CREATING))
        .order_by(AuditEvent.id.desc())
        .limit(1)
    )
    return session.scalar(query)


def model_page_of(session: Session, settings: Settings, name: str) -> ModelPage:
    custom = session.scalar(select(Model).where(Model.slug == name))
    if custom is not None:
        pending = feedback_store.count(
            session, [Feedback.model_id == custom.id, Feedback.status == FeedbackStatus.PENDING]
        )
        limit = serve_only(session, settings, custom.base_model)
        return ModelPage(
            kind="custom",
            key=custom.slug,
            name=custom.name,
            avatar=avatar_of(custom),
            traffic=traffic(session, name, Identity(custom.slug, None)),
            next=custom_next(custom, pending, busy(session, custom), limit),
            status=custom_status(session, custom, pending, limit),
            created_at=custom.created_at,
            created_by=creator(session, custom.slug),
        )
    base = session.get(BaseRow, name)
    if base is None:
        raise no_model(session, name)
    return ModelPage(
        kind="base",
        key=base.id,
        name=base.name,
        traffic=traffic(session, name, Identity(None, base.id)),
        next=base_next(base),
        status=base_status(session, settings, base),
        created_at=base.created_at,
        created_by=creator(session, base.id),
    )


@router.get(
    "/models/{name}/overview",
    dependencies=[Depends(viewer)],
    summary="Summarise a model for its page",
    description="Base keys and custom slugs share one namespace, so a name finds either kind of model.",
)
def read_model_page(name: str, session: SessionDep, settings: SettingsDep) -> ModelPage:
    return model_page_of(session, settings, name)
