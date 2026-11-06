import hashlib
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import ColumnElement, func, select
from sqlalchemy.orm import Session, sessionmaker

from minibrain.data.splits import HELD_OUT
from minibrain.policy import load as load_policy
from minibrain.registry.models import AuditEvent, Feedback, FeedbackStatus, Model, RequestLog, now
from minibrain.tasks.examples import ASSISTANT, Example, Turn, single, turns_of, well_formed

UP = "up"
DOWN = "down"
ORIGIN_API = "api"
ORIGIN_PLAYGROUND = "playground"
REVIEWED_PRIORITY = 0
CONFLICT = 2
UNSURE = 1

Verdict = tuple[bool, str | None]


class FeedbackError(Exception):
    pass


@dataclass(frozen=True)
class Submission:
    model_id: int
    origin: str
    rating: str
    response_id: str | None = None
    version: int | None = None
    key_id: int | None = None
    input: str | None = None
    output: str | None = None
    correction: str | None = None
    comment: str | None = None


@dataclass(frozen=True)
class Summary:
    version: int | None
    since: datetime | None
    total: int
    accepted: int
    pending: int
    rows: int
    examples: int


@dataclass(frozen=True)
class FeedbackRow:
    example: Example
    split: str | None


@dataclass(frozen=True)
class SavedExample:
    turns: tuple[Turn, ...]
    expected: str
    output: str | None = None
    version: int | None = None
    response_id: str | None = None


def cleaned(value: str | None) -> str | None:
    text = (value or "").strip()
    return text or None


def input_key(text: str) -> str:
    return hashlib.sha256(" ".join(text.split()).casefold().encode()).hexdigest()


def suggestion(item: Feedback) -> str | None:
    if item.correction:
        return item.correction
    return item.output if item.rating == UP else None


def verdict(item: Feedback) -> Verdict:
    if item.status == FeedbackStatus.ACCEPTED:
        return True, item.label
    found = suggestion(item)
    return (True, found) if found is not None else (False, item.output)


def signal(item: Feedback, verdicts: set[Verdict]) -> int:
    if len(verdicts) > 1:
        return CONFLICT
    return UNSURE if item.rating == DOWN and not item.correction else 0


def refresh_group(session: Session, model_id: int, key: str) -> None:
    session.flush()
    query = select(Feedback).where(
        Feedback.model_id == model_id,
        Feedback.input_key == key,
        Feedback.status != FeedbackStatus.REJECTED,
    )
    items = list(session.scalars(query))
    verdicts = {verdict(item) for item in items}
    for item in items:
        pending = item.status == FeedbackStatus.PENDING
        item.priority = 1 + signal(item, verdicts) if pending else REVIEWED_PRIORITY


def logged_request(session: Session, model_id: int, response_id: str | None) -> RequestLog | None:
    if not response_id:
        return None
    query = select(RequestLog).where(RequestLog.response_id == response_id, RequestLog.model_id == model_id)
    return session.scalar(query.order_by(RequestLog.id.desc()).limit(1))


def missing_input(session: Session, model_id: int, response_id: str | None) -> str:
    model = session.get(Model, model_id)
    policy = load_policy(session)
    if model is not None and not policy.keeps_bodies(model.request_bodies):
        where = (
            "locked off for every model under Settings, Security"
            if policy["request_bodies_locked"]
            else f"turn it on under Deployments, {model.name}"
        )
        return (
            f"Send input with the feedback: {model.name} does not keep request inputs and answers "
            f"(Keep request inputs and answers: {where})."
        )
    return f"Send input with the feedback: no kept request has the response ID {response_id or '(none)'}."


def open_feedback(session: Session, submission: Submission) -> Feedback | None:
    if not submission.response_id:
        return None
    query = select(Feedback).where(
        Feedback.model_id == submission.model_id,
        Feedback.response_id == submission.response_id,
        Feedback.status == FeedbackStatus.PENDING,
    )
    return session.scalar(query.order_by(Feedback.id.desc()).limit(1))


def record(session: Session, submission: Submission) -> Feedback:
    log = logged_request(session, submission.model_id, submission.response_id)
    text = cleaned(submission.input) or (cleaned(log.input) if log else None)
    if text is None:
        raise FeedbackError(missing_input(session, submission.model_id, submission.response_id))
    correction = cleaned(submission.correction)
    if submission.rating == UP and correction:
        raise FeedbackError("A correction goes with a thumbs-down: send rating down with the right answer.")
    item = open_feedback(session, submission)
    before = item.input_key if item else None
    if item is None:
        item = Feedback(model_id=submission.model_id, origin=submission.origin)
        session.add(item)
    item.response_id = submission.response_id
    item.version = log.version if log is not None else submission.version
    item.key_id = submission.key_id
    item.rating = submission.rating
    item.input = text
    item.input_key = input_key(text)
    item.output = cleaned(submission.output) or (cleaned(log.output) if log else None)
    item.correction = correction
    item.comment = cleaned(submission.comment)
    item.status = FeedbackStatus.PENDING
    item.updated_at = now()
    refresh_group(session, submission.model_id, item.input_key)
    if before is not None and before != item.input_key:
        refresh_group(session, submission.model_id, before)
    return item


def database_feedback(sessions: sessionmaker[Session]) -> Callable[[Submission], int]:
    def store(submission: Submission) -> int:
        with sessions() as session:
            item = record(session, submission)
            session.commit()
            return item.id

    return store


def target_of(item: Feedback) -> str:
    return f"{item.model.slug}/feedback/{item.id}"


def audit(session: Session, item: Feedback, actor: str, action: str, detail: dict) -> None:
    session.add(
        AuditEvent(actor=actor, action=action, target=target_of(item), detail={"name": item.model.name} | detail)
    )


def review(session: Session, item: Feedback, accept: bool, label: str | None, actor: str) -> Feedback:
    before = item.status
    if accept:
        fixed = cleaned(label)
        chosen = fixed or suggestion(item)
        if chosen is None:
            raise FeedbackError("Enter the right answer to accept this feedback.")
        action = "feedback.fix" if fixed is not None and fixed != suggestion(item) else "feedback.accept"
        item.status = FeedbackStatus.ACCEPTED
        item.label = chosen
    else:
        action = "feedback.reject"
        item.status = FeedbackStatus.REJECTED
        item.label = None
        item.priority = REVIEWED_PRIORITY
    moment = now()
    item.reviewed_by = actor
    item.reviewed_at = moment
    item.updated_at = moment
    audit(session, item, actor, action, {"from": before, "status": item.status, "label": item.label})
    refresh_group(session, item.model_id, item.input_key)
    return item


def assign(session: Session, item: Feedback, mine: bool, actor: str) -> Feedback:
    before = item.assignee
    item.assignee = actor if mine else None
    item.updated_at = now()
    action = "feedback.assign" if mine else "feedback.unassign"
    audit(session, item, actor, action, {"from": before, "to": item.assignee})
    return item


def related(session: Session, item: Feedback) -> list[Feedback]:
    query = select(Feedback).where(
        Feedback.model_id == item.model_id,
        Feedback.input_key == item.input_key,
        Feedback.id != item.id,
    )
    return list(session.scalars(query.order_by(Feedback.id.desc()).limit(20)))


def count(session: Session, where: list[ColumnElement[bool]]) -> int:
    return session.scalar(select(func.count()).select_from(Feedback).where(*where)) or 0


def held_out_examples(model_ids: list[int]) -> list[ColumnElement[bool]]:
    return [
        Feedback.model_id.in_(model_ids),
        Feedback.status == FeedbackStatus.ACCEPTED,
        Feedback.split == HELD_OUT,
    ]


def summary(session: Session, model: Model) -> Summary:
    newest = max(model.versions, key=lambda version: version.number, default=None)
    since = newest.created_at if newest is not None else None
    mine = Feedback.model_id == model.id
    accepted = Feedback.status == FeedbackStatus.ACCEPTED
    recent = [mine] if since is None else [mine, Feedback.created_at > since]
    return Summary(
        version=newest.number if newest is not None else None,
        since=since,
        total=count(session, recent),
        accepted=count(session, [*recent, accepted]),
        pending=count(session, [mine, Feedback.status == FeedbackStatus.PENDING]),
        rows=len(training_rows(session, model)),
        examples=count(session, held_out_examples([model.id])),
    )


def example_of(item: Feedback) -> Example | None:
    label = (item.label or "").strip()
    turns = turns_of(item.messages) if item.messages else (Turn("user", item.input.strip()),)
    if not label or not turns or not well_formed([*turns, Turn(ASSISTANT, label)]):
        return None
    return Example(turns=turns, expected=label) if item.messages else single(turns[0].content, label)


def training_rows(session: Session, model: Model) -> list[FeedbackRow]:
    query = (
        select(Feedback)
        .where(
            Feedback.model_id == model.id,
            Feedback.status == FeedbackStatus.ACCEPTED,
            Feedback.label.is_not(None),
        )
        .order_by(Feedback.reviewed_at, Feedback.id)
    )
    latest: dict[str, FeedbackRow] = {}
    for item in session.scalars(query):
        example = example_of(item)
        if example is not None:
            latest[example.input] = FeedbackRow(example=example, split=item.split)
    return list(latest.values())


def save_example(session: Session, model: Model, saved: SavedExample, actor: str) -> Feedback:
    expected = saved.expected.strip()
    turns = tuple(Turn(turn.role, turn.content.strip()) for turn in saved.turns)
    if not expected:
        raise FeedbackError("Enter the expected answer.")
    if not well_formed([*turns, Turn(ASSISTANT, expected)]):
        raise FeedbackError(
            "A test example is a conversation of user and assistant turns that ends with a user message, "
            "without tool calls."
        )
    example = Example(turns=turns, expected=expected)
    output = cleaned(saved.output)
    moment = now()
    item = Feedback(
        model=model,
        origin=ORIGIN_PLAYGROUND,
        response_id=saved.response_id,
        version=saved.version,
        rating=UP if output == expected else DOWN,
        input=example.input,
        input_key=input_key(example.input),
        output=output,
        correction=None if output == expected else expected,
        status=FeedbackStatus.ACCEPTED,
        label=expected,
        priority=REVIEWED_PRIORITY,
        reviewed_by=actor,
        reviewed_at=moment,
        created_at=moment,
        updated_at=moment,
        messages=example.messages(),
        split=HELD_OUT,
    )
    session.add(item)
    session.flush()
    detail = {"version": saved.version, "turns": len(turns), "split": HELD_OUT}
    audit(session, item, actor, "feedback.example", detail)
    refresh_group(session, model.id, item.input_key)
    return item


def saved_examples(session: Session, model: Model) -> list[Feedback]:
    query = select(Feedback).where(*held_out_examples([model.id]))
    return list(session.scalars(query.order_by(Feedback.reviewed_at.desc(), Feedback.id.desc())))


def example_counts(session: Session, models: list[Model]) -> dict[str, int]:
    slugs = {model.id: model.slug for model in models}
    if not slugs:
        return {}
    query = select(Feedback.model_id, func.count()).where(*held_out_examples(list(slugs))).group_by(Feedback.model_id)
    return {slugs[model_id]: int(total) for model_id, total in session.execute(query).all()}
