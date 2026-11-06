from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from minibrain.api.access import viewer
from minibrain.api.deps import SessionDep
from minibrain.api.overview import Identity, model_rows, series_points
from minibrain.api.request_logs import model_match
from minibrain.data import feedback as feedback_store
from minibrain.registry.models import (
    ACTIVE_JOB_STATUSES,
    BaseModelStatus,
    Feedback,
    FeedbackStatus,
    Job,
    Model,
    RequestLog,
    VersionStatus,
    now,
)
from minibrain.registry.models import BaseModel as BaseRow
from minibrain.registry.service import NotFoundError, latest_dataset_version
from minibrain.tasks.service import decision, live_version

router = APIRouter(prefix="/api", tags=["models"])

DAYS = 7
DAY = timedelta(days=1)

NextKind = Literal["promote", "deploy", "review_feedback", "add_data", "train", "create_custom"]


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


class ModelPage(BaseModel):
    kind: Literal["base", "custom"]
    key: str
    name: str
    traffic: ModelTraffic = Field(description="Requests per day, p95 latency and error rate over the last 7 days.")
    next: NextAction | None = Field(description="The one step the model page suggests, or none while busy.")


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


def passing_candidate(model: Model) -> int | None:
    current = model.current_version if model.deployed and model.current_version is not None else -1
    ready = [v for v in model.versions if v.status == VersionStatus.READY and v.number > current]
    passing = [v for v in ready if v.live_at is not None or decision(model, v).passed]
    best = max(passing, key=lambda v: v.number, default=None)
    return best.number if best is not None else None


def rows_text(count: int) -> str:
    return f"{count} feedback {'row' if count == 1 else 'rows'} to review"


def custom_next(model: Model, pending: int, working: bool) -> NextAction | None:
    if model.teardown is not None or working:
        return None
    candidate = passing_candidate(model)
    if candidate is not None:
        label = f"v{candidate} beats live, deploy it" if live_version(model) else f"Deploy v{candidate}"
        return NextAction(kind="promote", label=label, version=candidate)
    if not model.deployed:
        return NextAction(kind="deploy", label="Deploy")
    if pending > 0:
        return NextAction(kind="review_feedback", label=rows_text(pending), count=pending)
    if latest_dataset_version(model) is None:
        return NextAction(kind="add_data", label="Add training data")
    upcoming = max((v.number for v in model.versions), default=0) + 1
    return NextAction(kind="train", label=f"Train v{upcoming}", version=upcoming)


def base_next(model: BaseRow) -> NextAction | None:
    if model.teardown is not None or model.health or model.status != BaseModelStatus.AVAILABLE:
        return None
    if not model.deployed:
        return NextAction(kind="deploy", label="Deploy")
    return NextAction(kind="create_custom", label="Create a custom model from it")


def model_page_of(session: Session, name: str) -> ModelPage:
    custom = session.scalar(select(Model).where(Model.slug == name))
    if custom is not None:
        pending = feedback_store.count(
            session, [Feedback.model_id == custom.id, Feedback.status == FeedbackStatus.PENDING]
        )
        return ModelPage(
            kind="custom",
            key=custom.slug,
            name=custom.name,
            traffic=traffic(session, name, Identity(custom.slug, None)),
            next=custom_next(custom, pending, busy(session, custom)),
        )
    base = session.get(BaseRow, name)
    if base is None:
        raise NotFoundError(f"no model called {name}")
    return ModelPage(
        kind="base",
        key=base.id,
        name=base.name,
        traffic=traffic(session, name, Identity(None, base.id)),
        next=base_next(base),
    )


@router.get(
    "/model-pages/{name}",
    dependencies=[Depends(viewer)],
    summary="Summarise a model for its page",
    description="Base keys and custom slugs share one namespace, so a name finds either kind of model.",
)
def read_model_page(name: str, session: SessionDep) -> ModelPage:
    return model_page_of(session, name)
