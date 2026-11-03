from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import ColumnElement, and_, func, or_, select
from sqlalchemy.orm import Session, joinedload

from minibrain.api.deps import SessionDep
from minibrain.auth.identity import current_actor
from minibrain.data import feedback as store
from minibrain.data.feedback import CONFLICT, ORIGIN_PLAYGROUND, UNSURE, Submission, suggestion
from minibrain.registry.models import ApiKey, Feedback, FeedbackStatus, Minibrain
from minibrain.registry.service import NotFoundError, get_minibrain, latest_snapshot

router = APIRouter(prefix="/api", tags=["feedback"])

PAGE = 50
PAGE_MAX = 200
TEXT_MAX = 50_000
COMMENT_MAX = 2_000
ME = "me"
NOBODY = "none"

Signal = Literal["conflict", "unsure", "none"]
Facet = Literal["status", "minibrain"]


class FeedbackInfo(BaseModel):
    id: int
    model: str
    model_name: str
    version: int | None
    origin: str
    rating: Literal["up", "down"]
    input: str
    output: str | None
    correction: str | None
    comment: str | None
    suggestion: str | None
    status: Literal["pending", "accepted", "rejected"]
    label: str | None
    signal: Signal
    assignee: str | None
    reviewed_by: str | None
    reviewed_at: datetime | None
    response_id: str | None
    created_at: datetime


class FeedbackPage(BaseModel):
    items: list[FeedbackInfo]
    next_cursor: str | None
    total: int


class FeedbackFacets(BaseModel):
    total: int
    statuses: dict[str, int]
    minibrains: dict[str, int]


class LoggedRequest(BaseModel):
    at: datetime
    status: int
    latency_ms: float
    key_name: str | None


class FeedbackDetail(FeedbackInfo):
    related: list[FeedbackInfo]
    labels: list[str]
    request: LoggedRequest | None


class ReviewRequest(BaseModel):
    decision: Literal["accept", "reject"]
    label: str | None = Field(default=None, max_length=TEXT_MAX)


class AssignRequest(BaseModel):
    mine: bool


class PlaygroundFeedback(BaseModel):
    rating: Literal["up", "down"]
    input: str = Field(min_length=1, max_length=TEXT_MAX)
    output: str | None = Field(default=None, max_length=TEXT_MAX)
    correction: str | None = Field(default=None, max_length=TEXT_MAX)
    comment: str | None = Field(default=None, max_length=COMMENT_MAX)
    version: int | None = None
    response_id: str | None = Field(default=None, max_length=200)


class FeedbackSummary(BaseModel):
    version: int | None
    since: datetime | None
    total: int
    accepted: int
    pending: int
    rows: int


def signal_of(item: Feedback) -> Signal:
    if item.status != FeedbackStatus.PENDING:
        return "none"
    level = item.priority - 1
    return "conflict" if level >= CONFLICT else "unsure" if level >= UNSURE else "none"


def feedback_info(item: Feedback) -> FeedbackInfo:
    return FeedbackInfo(
        id=item.id,
        model=item.minibrain.slug,
        model_name=item.minibrain.name,
        version=item.version,
        origin=item.origin,
        rating="up" if item.rating == store.UP else "down",
        input=item.input,
        output=item.output,
        correction=item.correction,
        comment=item.comment,
        suggestion=suggestion(item),
        status=FeedbackStatus(item.status).value,
        label=item.label,
        signal=signal_of(item),
        assignee=item.assignee,
        reviewed_by=item.reviewed_by,
        reviewed_at=item.reviewed_at,
        response_id=item.response_id,
        created_at=item.created_at,
    )


@dataclass(frozen=True)
class FeedbackFilter:
    minibrains: list[str]
    statuses: list[str]
    assignees: list[str]
    q: str

    def conditions(self, skip: Facet | None = None) -> list[ColumnElement[bool]]:
        where: list[ColumnElement[bool]] = []
        if self.minibrains and skip != "minibrain":
            where.append(Feedback.minibrain_id.in_(select(Minibrain.id).where(Minibrain.slug.in_(self.minibrains))))
        if self.statuses and skip != "status":
            where.append(Feedback.status.in_(self.statuses))
        people = [current_actor() if name == ME else name for name in self.assignees if name != NOBODY]
        chosen = [Feedback.assignee.in_(people)] if people else []
        if NOBODY in self.assignees:
            chosen.append(Feedback.assignee.is_(None))
        if chosen:
            where.append(or_(*chosen))
        if self.q:
            text = (Feedback.input, Feedback.correction, Feedback.comment, Feedback.label)
            where.append(or_(*(column.icontains(self.q, autoescape=True) for column in text)))
        return where


def feedback_filter(
    model: Annotated[list[str] | None, Query()] = None,
    status: Annotated[list[str] | None, Query()] = None,
    assignee: Annotated[list[str] | None, Query()] = None,
    q: Annotated[str, Query(max_length=200)] = "",
) -> FeedbackFilter:
    return FeedbackFilter(minibrains=model or [], statuses=status or [], assignees=assignee or [], q=q.strip())


FilterDep = Annotated[FeedbackFilter, Depends(feedback_filter)]


def count(session: Session, where: list[ColumnElement[bool]]) -> int:
    return session.scalar(select(func.count()).select_from(Feedback).where(*where)) or 0


def after_cursor(cursor: str) -> ColumnElement[bool]:
    priority, _, identifier = cursor.partition(":")
    return or_(
        Feedback.priority < int(priority),
        and_(Feedback.priority == int(priority), Feedback.id < int(identifier)),
    )


@router.get("/feedback")
def list_feedback(
    session: SessionDep,
    filters: FilterDep,
    limit: int = PAGE,
    cursor: Annotated[str | None, Query(pattern=r"^\d{1,2}:\d{1,18}$")] = None,
) -> FeedbackPage:
    where = filters.conditions()
    size = max(1, min(limit, PAGE_MAX))
    query = select(Feedback).options(joinedload(Feedback.minibrain)).where(*where)
    if cursor is not None:
        query = query.where(after_cursor(cursor))
    found = list(session.scalars(query.order_by(Feedback.priority.desc(), Feedback.id.desc()).limit(size + 1)))
    shown = found[:size]
    last = shown[-1] if shown else None
    return FeedbackPage(
        items=[feedback_info(item) for item in shown],
        next_cursor=f"{last.priority}:{last.id}" if last is not None and len(found) > size else None,
        total=count(session, where),
    )


@router.get("/feedback/facets")
def feedback_facets(session: SessionDep, filters: FilterDep) -> FeedbackFacets:
    by_status = select(Feedback.status, func.count()).where(*filters.conditions("status")).group_by(Feedback.status)
    by_minibrain = (
        select(Minibrain.slug, func.count())
        .select_from(Feedback)
        .join(Minibrain, Feedback.minibrain_id == Minibrain.id)
        .where(*filters.conditions("minibrain"))
        .group_by(Minibrain.slug)
    )
    return FeedbackFacets(
        total=count(session, filters.conditions()),
        statuses={str(status): int(total) for status, total in session.execute(by_status).all()},
        minibrains={str(slug): int(total) for slug, total in session.execute(by_minibrain).all()},
    )


def get_feedback(session: Session, feedback_id: int) -> Feedback:
    item = session.get(Feedback, feedback_id)
    if item is None:
        raise NotFoundError(f"No feedback {feedback_id}")
    return item


def labels_for(session: Session, minibrain: Minibrain) -> list[str]:
    snapshot = latest_snapshot(minibrain)
    known = set(snapshot.labels if snapshot is not None else [])
    accepted = select(Feedback.label).where(
        Feedback.minibrain_id == minibrain.id, Feedback.status == FeedbackStatus.ACCEPTED
    )
    known |= {label for label in session.scalars(accepted.distinct()) if label}
    return sorted(known)


def logged_info(session: Session, item: Feedback) -> LoggedRequest | None:
    log = store.logged_request(session, item.minibrain_id, item.response_id)
    if log is None:
        return None
    key = session.get(ApiKey, log.key_id) if log.key_id is not None else None
    return LoggedRequest(at=log.at, status=log.status, latency_ms=log.latency_ms, key_name=key.name if key else None)


def feedback_detail(session: Session, item: Feedback) -> FeedbackDetail:
    extra = {
        "related": [feedback_info(other) for other in store.related(session, item)],
        "labels": labels_for(session, item.minibrain),
        "request": logged_info(session, item),
    }
    return FeedbackDetail.model_validate(feedback_info(item).model_dump() | extra)


@router.get("/feedback/{feedback_id}")
def read_feedback(feedback_id: int, session: SessionDep) -> FeedbackDetail:
    return feedback_detail(session, get_feedback(session, feedback_id))


@router.post("/feedback/{feedback_id}/review")
def review_feedback(feedback_id: int, body: ReviewRequest, session: SessionDep) -> FeedbackDetail:
    item = store.review(
        session, get_feedback(session, feedback_id), body.decision == "accept", body.label, current_actor()
    )
    session.commit()
    return feedback_detail(session, item)


@router.post("/feedback/{feedback_id}/assign")
def assign_feedback(feedback_id: int, body: AssignRequest, session: SessionDep) -> FeedbackDetail:
    item = store.assign(session, get_feedback(session, feedback_id), body.mine, current_actor())
    session.commit()
    return feedback_detail(session, item)


@router.post("/minibrains/{slug}/feedback", status_code=201)
def playground_feedback(slug: str, body: PlaygroundFeedback, session: SessionDep) -> FeedbackInfo:
    minibrain = get_minibrain(session, slug)
    submission = Submission(
        minibrain_id=minibrain.id,
        origin=ORIGIN_PLAYGROUND,
        rating=body.rating,
        response_id=body.response_id,
        version=body.version,
        input=body.input,
        output=body.output,
        correction=body.correction,
        comment=body.comment,
    )
    item = store.record(session, submission)
    session.commit()
    return feedback_info(item)


@router.get("/minibrains/{slug}/feedback/summary")
def feedback_summary(slug: str, session: SessionDep) -> FeedbackSummary:
    found = store.summary(session, get_minibrain(session, slug))
    return FeedbackSummary(
        version=found.version,
        since=found.since,
        total=found.total,
        accepted=found.accepted,
        pending=found.pending,
        rows=found.rows,
    )
