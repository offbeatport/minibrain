from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import ColumnElement, and_, func, or_, select
from sqlalchemy.orm import Session, joinedload

from minibrain.api.access import builder, viewer
from minibrain.api.deps import SessionDep
from minibrain.auth.identity import current_actor
from minibrain.data import feedback as store
from minibrain.data.feedback import CONFLICT, ORIGIN_PLAYGROUND, UNSURE, SavedExample, Submission, suggestion
from minibrain.data.splits import HELD_OUT
from minibrain.registry.models import ApiKey, Feedback, FeedbackStatus, Model
from minibrain.registry.service import NotFoundError, get_model, latest_dataset_version
from minibrain.tasks.examples import Turn
from minibrain.tasks.service import contract_of

router = APIRouter(prefix="/api")

PAGE = 50
PAGE_MAX = 200
TEXT_MAX = 50_000
COMMENT_MAX = 2_000
ME = "me"
NOBODY = "none"

Signal = Literal["conflict", "unsure", "none"]
Facet = Literal["status", "model"]


class ExampleTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=TEXT_MAX)


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
    held_out: bool = Field(description="A test example: always in the held-out rows the next version is scored on.")
    messages: list[ExampleTurn] | None = Field(
        default=None, description="A test example's turns before the expected answer."
    )


class FeedbackPage(BaseModel):
    items: list[FeedbackInfo]
    next_cursor: str | None
    total: int


class FeedbackFacets(BaseModel):
    total: int
    statuses: dict[str, int]
    models: dict[str, int]


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


class SaveExampleBody(BaseModel):
    messages: list[ExampleTurn] = Field(min_length=1, max_length=200)
    expected: str = Field(min_length=1, max_length=TEXT_MAX)
    output: str | None = Field(default=None, max_length=TEXT_MAX)
    version: int | None = None
    response_id: str | None = Field(default=None, max_length=200)


class FeedbackSummary(BaseModel):
    version: int | None
    since: datetime | None
    total: int
    accepted: int
    pending: int
    rows: int
    examples: int = Field(description="Test examples saved from the Playground, held out for scoring.")


def signal_of(item: Feedback) -> Signal:
    if item.status != FeedbackStatus.PENDING:
        return "none"
    level = item.priority - 1
    return "conflict" if level >= CONFLICT else "unsure" if level >= UNSURE else "none"


def feedback_info(item: Feedback) -> FeedbackInfo:
    return FeedbackInfo(
        id=item.id,
        model=item.model.slug,
        model_name=item.model.name,
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
        held_out=item.split == HELD_OUT,
        messages=[ExampleTurn.model_validate(turn) for turn in item.messages] if item.messages else None,
    )


@dataclass(frozen=True)
class FeedbackFilter:
    models: list[str]
    statuses: list[str]
    assignees: list[str]
    q: str

    def conditions(self, skip: Facet | None = None) -> list[ColumnElement[bool]]:
        where: list[ColumnElement[bool]] = []
        if self.models and skip != "model":
            where.append(Feedback.model_id.in_(select(Model.id).where(Model.slug.in_(self.models))))
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
    return FeedbackFilter(models=model or [], statuses=status or [], assignees=assignee or [], q=q.strip())


FilterDep = Annotated[FeedbackFilter, Depends(feedback_filter)]


def count(session: Session, where: list[ColumnElement[bool]]) -> int:
    return session.scalar(select(func.count()).select_from(Feedback).where(*where)) or 0


def after_cursor(cursor: str) -> ColumnElement[bool]:
    priority, _, identifier = cursor.partition(":")
    return or_(
        Feedback.priority < int(priority),
        and_(Feedback.priority == int(priority), Feedback.id < int(identifier)),
    )


@router.get("/feedback", dependencies=[Depends(builder)], summary="List feedback")
def list_feedback(
    session: SessionDep,
    filters: FilterDep,
    limit: int = PAGE,
    cursor: Annotated[str | None, Query(pattern=r"^\d{1,2}:\d{1,18}$")] = None,
) -> FeedbackPage:
    where = filters.conditions()
    size = max(1, min(limit, PAGE_MAX))
    query = select(Feedback).options(joinedload(Feedback.model)).where(*where)
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


@router.get("/feedback/facets", dependencies=[Depends(builder)], summary="Count feedback by filter")
def feedback_facets(session: SessionDep, filters: FilterDep) -> FeedbackFacets:
    by_status = select(Feedback.status, func.count()).where(*filters.conditions("status")).group_by(Feedback.status)
    by_model = (
        select(Model.slug, func.count())
        .select_from(Feedback)
        .join(Model, Feedback.model_id == Model.id)
        .where(*filters.conditions("model"))
        .group_by(Model.slug)
    )
    return FeedbackFacets(
        total=count(session, filters.conditions()),
        statuses={str(status): int(total) for status, total in session.execute(by_status).all()},
        models={str(slug): int(total) for slug, total in session.execute(by_model).all()},
    )


def get_feedback(session: Session, feedback_id: int) -> Feedback:
    item = session.get(Feedback, feedback_id)
    if item is None:
        raise NotFoundError(f"No feedback {feedback_id}")
    return item


def labels_for(session: Session, model: Model) -> list[str]:
    contract = contract_of(model).labels
    if contract is None:
        return []
    dataset_version = latest_dataset_version(model)
    known = set(contract) | set(dataset_version.labels if dataset_version is not None else [])
    accepted = select(Feedback.label).where(Feedback.model_id == model.id, Feedback.status == FeedbackStatus.ACCEPTED)
    known |= {label for label in session.scalars(accepted.distinct()) if label}
    return sorted(known)


def logged_info(session: Session, item: Feedback) -> LoggedRequest | None:
    log = store.logged_request(session, item.model_id, item.response_id)
    if log is None:
        return None
    key = session.get(ApiKey, log.key_id) if log.key_id is not None else None
    return LoggedRequest(at=log.at, status=log.status, latency_ms=log.latency_ms, key_name=key.name if key else None)


def feedback_detail(session: Session, item: Feedback) -> FeedbackDetail:
    extra = {
        "related": [feedback_info(other) for other in store.related(session, item)],
        "labels": labels_for(session, item.model),
        "request": logged_info(session, item),
    }
    return FeedbackDetail.model_validate(feedback_info(item).model_dump() | extra)


@router.get("/feedback/{feedback_id}", dependencies=[Depends(builder)], summary="Read feedback")
def read_feedback(feedback_id: int, session: SessionDep) -> FeedbackDetail:
    return feedback_detail(session, get_feedback(session, feedback_id))


@router.post("/feedback/{feedback_id}/review", dependencies=[Depends(builder)], summary="Accept or reject feedback")
def review_feedback(feedback_id: int, body: ReviewRequest, session: SessionDep) -> FeedbackDetail:
    item = store.review(
        session, get_feedback(session, feedback_id), body.decision == "accept", body.label, current_actor()
    )
    session.commit()
    return feedback_detail(session, item)


@router.post("/feedback/{feedback_id}/assign", dependencies=[Depends(builder)], summary="Assign feedback to me")
def assign_feedback(feedback_id: int, body: AssignRequest, session: SessionDep) -> FeedbackDetail:
    item = store.assign(session, get_feedback(session, feedback_id), body.mine, current_actor())
    session.commit()
    return feedback_detail(session, item)


@router.post(
    "/models/{name}/feedback",
    status_code=201,
    dependencies=[Depends(viewer)],
    summary="Rate an answer from the Playground",
)
def playground_feedback(name: str, body: PlaygroundFeedback, session: SessionDep) -> FeedbackInfo:
    model = get_model(session, name)
    submission = Submission(
        model_id=model.id,
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


@router.get(
    "/models/{name}/feedback/summary",
    dependencies=[Depends(viewer)],
    summary="Count a model's feedback since its last version",
)
def feedback_summary(name: str, session: SessionDep) -> FeedbackSummary:
    found = store.summary(session, get_model(session, name))
    return FeedbackSummary(
        version=found.version,
        since=found.since,
        total=found.total,
        accepted=found.accepted,
        pending=found.pending,
        rows=found.rows,
        examples=found.examples,
    )


@router.post(
    "/models/{name}/test-examples",
    status_code=201,
    dependencies=[Depends(builder)],
    summary="Save a test example",
    description=(
        "Adds a conversation and its expected answer to the model's accepted feedback, held out for scoring: it joins "
        "the held-out rows of the dataset version the next model version starts from, so that version is scored on "
        "it. Audited as feedback.example."
    ),
)
def save_test_example(name: str, body: SaveExampleBody, session: SessionDep) -> FeedbackInfo:
    model = get_model(session, name)
    saved = SavedExample(
        turns=tuple(Turn(turn.role, turn.content) for turn in body.messages),
        expected=body.expected,
        output=body.output,
        version=body.version,
        response_id=body.response_id,
    )
    item = store.save_example(session, model, saved, current_actor())
    session.commit()
    return feedback_info(item)


@router.delete(
    "/models/{name}/test-examples/{feedback_id}",
    status_code=204,
    dependencies=[Depends(builder)],
    summary="Remove a test example",
    description=(
        "Rejects the test example, so the next version's held-out rows leave it out; versions already scored keep "
        "their rows. Audited as feedback.example_remove."
    ),
)
def remove_test_example(name: str, feedback_id: int, session: SessionDep) -> None:
    model = get_model(session, name)
    item = get_feedback(session, feedback_id)
    if item.model_id != model.id:
        raise NotFoundError(f"No test example {feedback_id} on {model.name}")
    store.remove_example(session, item, current_actor())
    session.commit()


@router.get("/models/{name}/test-examples", dependencies=[Depends(builder)], summary="List test examples")
def list_test_examples(name: str, session: SessionDep) -> list[FeedbackInfo]:
    return [feedback_info(item) for item in store.saved_examples(session, get_model(session, name))]
