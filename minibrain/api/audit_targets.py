from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel
from sqlalchemy import select, tuple_
from sqlalchemy.orm import InstrumentedAttribute, Session

from minibrain.api.model_activity import display_names
from minibrain.registry.models import (
    SYSTEM_ACTOR,
    ApiKey,
    AuditEvent,
    Connection,
    Dataset,
    DatasetFolder,
    Feedback,
    Job,
    Model,
    User,
    Version,
)
from minibrain.registry.models import BaseModel as BaseRow

TargetKind = Literal[
    "model", "version", "key", "account", "job", "dataset", "dataset_folder", "feedback", "connection", "policy"
]
ActorKind = Literal["user", "api_key", "command_line", "system"]

KEY_ACTOR = "api_key:"
COMMAND_LINE = "command line"
PREFIXED: dict[str, TargetKind] = {
    "job": "job",
    "dataset": "dataset",
    "dataset_folder": "dataset_folder",
    "connection": "connection",
}
BY_CATEGORY: dict[str, TargetKind] = {
    "model": "model",
    "safety": "model",
    "version": "version",
    "key": "key",
    "account": "account",
    "auth": "account",
    "feedback": "feedback",
    "policy": "policy",
}
ACCOUNT_ACTIONS = {"auth.sign_in", "auth.sign_out", "auth.sign_in_failed"}


class AuditTarget(BaseModel):
    kind: TargetKind
    key: str
    live: bool


@dataclass(frozen=True)
class Ref:
    kind: TargetKind
    key: str


def category_of(action: str) -> str:
    return action.partition(".")[0]


def actor_kind(actor: str) -> ActorKind:
    if actor == SYSTEM_ACTOR:
        return "system"
    if actor == COMMAND_LINE:
        return "command_line"
    if actor.startswith(KEY_ACTOR):
        return "api_key"
    return "user"


def ref_of(event: AuditEvent) -> Ref | None:
    category = category_of(event.action)
    head, colon, rest = event.target.partition(":")
    if colon and head in PREFIXED and category == head:
        return Ref(PREFIXED[head], rest)
    kind = BY_CATEGORY.get(category)
    if kind is None or (category == "auth" and event.action not in ACCOUNT_ACTIONS):
        return None
    if category == "safety" and "@" in event.target:
        return Ref("version", event.target)
    if kind == "version" and "@" not in event.target:
        return None
    return Ref(kind, event.target)


def numbers(keys: Iterable[str]) -> set[int]:
    return {int(key) for key in keys if key.isdigit()}


def models_live(session: Session, keys: set[str]) -> set[str]:
    custom = session.scalars(select(Model.slug).where(Model.slug.in_(keys)))
    base = session.scalars(select(BaseRow.id).where(BaseRow.id.in_(keys)))
    return {*custom, *base}


def versions_live(session: Session, keys: set[str]) -> set[str]:
    pairs = {(slug, int(number)) for slug, _, number in (key.rpartition("@") for key in keys) if number.isdigit()}
    if not pairs:
        return set()
    query = (
        select(Model.slug, Version.number)
        .join(Version, Version.model_id == Model.id)
        .where(tuple_(Model.slug, Version.number).in_(pairs))
    )
    return {f"{slug}@{number}" for slug, number in session.execute(query)}


def keys_live(session: Session, keys: set[str]) -> set[str]:
    return set(session.scalars(select(ApiKey.prefix).where(ApiKey.prefix.in_(keys))))


def accounts_live(session: Session, keys: set[str]) -> set[str]:
    found = session.execute(select(User.email, User.subject).where(User.email.in_(keys) | User.subject.in_(keys)))
    return {handle for row in found for handle in row if handle in keys}


def by_id(column: InstrumentedAttribute[int]) -> Callable[[Session, set[str]], set[str]]:
    def live(session: Session, keys: set[str]) -> set[str]:
        wanted = numbers(keys)
        return {str(found) for found in session.scalars(select(column).where(column.in_(wanted)))} if wanted else set()

    return live


def datasets_live(session: Session, keys: set[str]) -> set[str]:
    return set(session.scalars(select(Dataset.slug).where(Dataset.slug.in_(keys))))


def feedback_live(session: Session, keys: set[str]) -> set[str]:
    wanted = {key.rpartition("/")[2]: key for key in keys}
    found = by_id(Feedback.id)(session, set(wanted))
    return {wanted[number] for number in found}


def everything(_session: Session, keys: set[str]) -> set[str]:
    return keys


LIVE: dict[TargetKind, Callable[[Session, set[str]], set[str]]] = {
    "model": models_live,
    "version": versions_live,
    "key": keys_live,
    "account": accounts_live,
    "job": by_id(Job.id),
    "dataset": datasets_live,
    "dataset_folder": by_id(DatasetFolder.id),
    "feedback": feedback_live,
    "connection": by_id(Connection.id),
    "policy": everything,
}


def targets_of(session: Session, events: list[AuditEvent]) -> dict[int, AuditTarget]:
    refs = {event.id: ref for event in events if (ref := ref_of(event)) is not None}
    wanted: dict[TargetKind, set[str]] = {}
    for ref in refs.values():
        wanted.setdefault(ref.kind, set()).add(ref.key)
    live = {kind: LIVE[kind](session, keys) for kind, keys in wanted.items()}
    return {
        event_id: AuditTarget(kind=ref.kind, key=ref.key, live=ref.key in live[ref.kind])
        for event_id, ref in refs.items()
    }


def key_names(session: Session, actors: set[str]) -> dict[str, str]:
    wanted = {actor: actor.removeprefix(KEY_ACTOR) for actor in actors if actor.startswith(KEY_ACTOR)}
    ids = numbers(wanted.values())
    if not ids:
        return {}
    names = {key_id: name for key_id, name in session.execute(select(ApiKey.id, ApiKey.name).where(ApiKey.id.in_(ids)))}
    return {actor: names[int(raw)] for actor, raw in wanted.items() if raw.isdigit() and int(raw) in names}


def actor_names(session: Session, events: list[AuditEvent]) -> dict[str, str]:
    actors = {event.actor for event in events}
    people = {actor for actor in actors if actor_kind(actor) == "user"}
    return display_names(session, people) | key_names(session, actors)
