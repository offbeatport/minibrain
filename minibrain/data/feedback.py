import hashlib
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import ColumnElement, func, select
from sqlalchemy.orm import Session, sessionmaker

from minibrain.data.snapshot import Example
from minibrain.policy import load as load_policy
from minibrain.registry.models import AuditEvent, Feedback, FeedbackStatus, Minibrain, RequestLog, now

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
    minibrain_id: int
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


def refresh_group(session: Session, minibrain_id: int, key: str) -> None:
    session.flush()
    query = select(Feedback).where(
        Feedback.minibrain_id == minibrain_id,
        Feedback.input_key == key,
        Feedback.status != FeedbackStatus.REJECTED,
    )
    items = list(session.scalars(query))
    verdicts = {verdict(item) for item in items}
    for item in items:
        pending = item.status == FeedbackStatus.PENDING
        item.priority = 1 + signal(item, verdicts) if pending else REVIEWED_PRIORITY


def logged_request(session: Session, minibrain_id: int, response_id: str | None) -> RequestLog | None:
    if not response_id:
        return None
    query = select(RequestLog).where(RequestLog.response_id == response_id, RequestLog.minibrain_id == minibrain_id)
    return session.scalar(query.order_by(RequestLog.id.desc()).limit(1))


def missing_input(session: Session, response_id: str | None) -> str:
    policy = load_policy(session)
    if not policy["request_logs"]:
        return "Send input with the feedback: request logs are off, so this install did not keep the request."
    if not policy["request_bodies"]:
        return (
            "Send input with the feedback: request inputs are not kept "
            "(Settings, Security, Request inputs and answers)."
        )
    return f"Send input with the feedback: no kept request has the response ID {response_id or '(none)'}."


def open_feedback(session: Session, submission: Submission) -> Feedback | None:
    if not submission.response_id:
        return None
    query = select(Feedback).where(
        Feedback.minibrain_id == submission.minibrain_id,
        Feedback.response_id == submission.response_id,
        Feedback.status == FeedbackStatus.PENDING,
    )
    return session.scalar(query.order_by(Feedback.id.desc()).limit(1))


def record(session: Session, submission: Submission) -> Feedback:
    log = logged_request(session, submission.minibrain_id, submission.response_id)
    text = cleaned(submission.input) or (cleaned(log.input) if log else None)
    if text is None:
        raise FeedbackError(missing_input(session, submission.response_id))
    correction = cleaned(submission.correction)
    if submission.rating == UP and correction:
        raise FeedbackError("A correction goes with a thumbs-down: send rating down with the right answer.")
    item = open_feedback(session, submission)
    before = item.input_key if item else None
    if item is None:
        item = Feedback(minibrain_id=submission.minibrain_id, origin=submission.origin)
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
    refresh_group(session, submission.minibrain_id, item.input_key)
    if before is not None and before != item.input_key:
        refresh_group(session, submission.minibrain_id, before)
    return item


def database_feedback(sessions: sessionmaker[Session]) -> Callable[[Submission], int]:
    def store(submission: Submission) -> int:
        with sessions() as session:
            item = record(session, submission)
            session.commit()
            return item.id

    return store


def target_of(item: Feedback) -> str:
    return f"{item.minibrain.slug}/feedback/{item.id}"


def audit(session: Session, item: Feedback, actor: str, action: str, detail: dict) -> None:
    session.add(
        AuditEvent(actor=actor, action=action, target=target_of(item), detail={"name": item.minibrain.name} | detail)
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
    refresh_group(session, item.minibrain_id, item.input_key)
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
        Feedback.minibrain_id == item.minibrain_id,
        Feedback.input_key == item.input_key,
        Feedback.id != item.id,
    )
    return list(session.scalars(query.order_by(Feedback.id.desc()).limit(20)))


def count(session: Session, where: list[ColumnElement[bool]]) -> int:
    return session.scalar(select(func.count()).select_from(Feedback).where(*where)) or 0


def summary(session: Session, minibrain: Minibrain) -> Summary:
    newest = max(minibrain.versions, key=lambda version: version.number, default=None)
    since = newest.created_at if newest is not None else None
    mine = Feedback.minibrain_id == minibrain.id
    accepted = Feedback.status == FeedbackStatus.ACCEPTED
    recent = [mine] if since is None else [mine, Feedback.created_at > since]
    return Summary(
        version=newest.number if newest is not None else None,
        since=since,
        total=count(session, recent),
        accepted=count(session, [*recent, accepted]),
        pending=count(session, [mine, Feedback.status == FeedbackStatus.PENDING]),
        rows=len(training_rows(session, minibrain)),
    )


def training_rows(session: Session, minibrain: Minibrain) -> list[Example]:
    query = (
        select(Feedback)
        .where(
            Feedback.minibrain_id == minibrain.id,
            Feedback.status == FeedbackStatus.ACCEPTED,
            Feedback.label.is_not(None),
        )
        .order_by(Feedback.reviewed_at, Feedback.id)
    )
    latest: dict[str, Example] = {}
    for item in session.scalars(query):
        text, label = item.input.strip(), (item.label or "").strip()
        if text and label:
            latest[text] = Example(input=text, label=label)
    return list(latest.values())
