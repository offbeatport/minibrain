from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import ColumnElement, String, and_, cast, or_, select
from sqlalchemy.orm import Session

from minibrain.api.access import viewer
from minibrain.api.deps import SessionDep
from minibrain.api.request_logs import aware
from minibrain.registry.models import AuditEvent, Job, Model
from minibrain.registry.models import BaseModel as BaseRow
from minibrain.registry.service import NotFoundError

router = APIRouter(prefix="/api", tags=["models"])

LinkKind = Literal["model", "version", "job", "key", "base", "monitoring"]
Tone = Literal["neutral", "success", "failed"]
DEFAULT_LIMIT = 40
MAX_LIMIT = 200


class ActivityLink(BaseModel):
    kind: LinkKind
    label: str
    version: int | None = None
    job_id: int | None = None
    job_kind: str | None = None
    key: str | None = None


class ModelActivityEvent(BaseModel):
    id: int
    at: datetime
    actor: str
    action: str
    text: str
    link: ActivityLink | None
    tone: Tone


class ModelActivity(BaseModel):
    events: list[ModelActivityEvent]
    total: int


@dataclass(frozen=True)
class Owner:
    key: str
    name: str
    custom: bool


@dataclass(frozen=True)
class Said:
    text: str
    link: ActivityLink | None = None
    tone: Tone = "neutral"


def owner_of(session: Session, name: str) -> Owner:
    custom = session.scalar(select(Model).where(Model.slug == name))
    if custom is not None:
        return Owner(custom.slug, custom.name, True)
    base = session.get(BaseRow, name)
    if base is None:
        raise NotFoundError(f"no model called {name}")
    return Owner(base.id, base.name, False)


def number_of(target: str) -> int | None:
    _, _, number = target.rpartition("@")
    return int(number) if number.isdigit() else None


def detail_text(event: AuditEvent, field: str) -> str | None:
    value = (event.detail or {}).get(field)
    return str(value) if value is not None and value != "" else None


def humanised(action: str) -> str:
    return action.replace(".", " ").replace("_", " ")


def version_said(event: AuditEvent) -> Said:
    number = number_of(event.target)
    name = f"v{number}"
    link = ActivityLink(kind="version", label=name, version=number)
    if event.action == "version.create":
        if (event.detail or {}).get("duplicated_from"):
            return Said(f"copied {name} from another model", link)
        if detail_text(event, "kind") == "prompt":
            return Said(f"scored {name}, prompt only", link)
        return Said(f"started training {name}", link)
    if event.action == "version.promote":
        return Said(f"made {name} live", link, "success")
    if event.action in ("version.delete", "version.delete_finished"):
        return Said(f"deleted {name}")
    if event.action == "version.card":
        return Said(f"edited the {name} model card", link)
    return Said(f"{humanised(event.action)} {name}", link)


def key_said(event: AuditEvent) -> Said:
    name = detail_text(event, "name") or event.target
    link = ActivityLink(kind="key", label=name, key=event.target)
    verbs = {
        "key.create": f"created API key {name}",
        "key.revoke": f"revoked API key {name}",
        "key.update": f"changed the models of API key {name}",
    }
    return Said(verbs.get(event.action, f"{humanised(event.action)} {name}"), link)


def job_said(session: Session, event: AuditEvent) -> Said:
    raw = event.target.removeprefix("job:")
    number = int(raw) if raw.isdigit() else None
    label = f"job #{number}" if number is not None else event.target
    kind = event.detail.get("kind") if isinstance(event.detail.get("kind"), str) else None
    exists = number is not None and session.get(Job, number) is not None
    link = ActivityLink(kind="job", label=label, job_id=number, job_kind=kind) if exists else None
    verbs = {"job.cancel": f"cancelled {label}", "job.retry": f"retried {label}", "job.delete": f"deleted {label}"}
    return Said(verbs.get(event.action, f"{humanised(event.action)} {label}"), link)


def changed_fields(event: AuditEvent) -> dict[str, Any]:
    after = (event.detail or {}).get("to")
    return after if isinstance(after, dict) else {}


def update_said(event: AuditEvent) -> Said:
    after = changed_fields(event)
    if after.get("name"):
        return Said(f"renamed it to {after['name']}")
    if set(after) == {"tags"}:
        return Said("changed the tags")
    if set(after) == {"description"}:
        return Said("changed the description")
    return Said("changed the description and tags")


def base_change_said(session: Session, event: AuditEvent) -> Said:
    key = detail_text(event, "to") or ""
    base = session.get(BaseRow, key) if key else None
    name = base.name if base is not None else key
    return Said(f"switched the base to {name}", ActivityLink(kind="base", label=name, key=key))


def fixed(text: str, tone: Tone = "neutral") -> Callable[[Owner, AuditEvent], Said]:
    return lambda owner, event: Said(text, None, tone)


def created(owner: Owner, event: AuditEvent) -> Said:
    name = detail_text(event, "name") or owner.name
    return Said(f"created {name}", ActivityLink(kind="model", label=name, key=owner.key))


def duplicated(owner: Owner, event: AuditEvent) -> Said:
    name = detail_text(event, "name") or owner.name
    source = detail_text(event, "source") or "another model"
    return Said(f"duplicated {source} as {name}", ActivityLink(kind="model", label=name, key=owner.key))


def deployed(owner: Owner, event: AuditEvent) -> Said:
    return Said(f"deployed {owner.key}", ActivityLink(kind="monitoring", label=owner.key, key=owner.key), "success")


def undeployed(owner: Owner, event: AuditEvent) -> Said:
    return Said(f"undeployed {owner.key}")


def deleted(owner: Owner, event: AuditEvent) -> Said:
    return Said(f"deleted {owner.name}", None, "failed")


def kept(owner: Owner, event: AuditEvent) -> Said:
    return Said(f"turned keeping inputs and answers {'on' if (event.detail or {}).get('to') else 'off'}")


def updated(owner: Owner, event: AuditEvent) -> Said:
    return update_said(event)


SENTENCES: dict[str, Callable[[Owner, AuditEvent], Said]] = {
    "model.create": created,
    "model.duplicate": duplicated,
    "model.deploy": deployed,
    "model.undeploy": undeployed,
    "model.undeploy_finished": fixed("finished undeploying"),
    "model.delete": deleted,
    "model.instructions": fixed("changed the instructions"),
    "model.graders": fixed("changed the graders"),
    "model.promotion": fixed("changed the promotion rule"),
    "model.contract": fixed("changed the answers"),
    "model.judge": fixed("changed the judge"),
    "model.safety": fixed("changed the safety model"),
    "model.labels_dismiss": fixed("dismissed the proposed labels"),
    "model.request_bodies": kept,
    "model.update": updated,
    "model.verify": fixed("started checking the files"),
    "model.repair": fixed("started repairing the files"),
    "model.reimport": fixed("started importing the files again"),
    "model.relocate": fixed("started moving the files"),
}


def said(session: Session, owner: Owner, event: AuditEvent) -> Said:
    if event.action.startswith("version."):
        return version_said(event)
    if event.action.startswith("key."):
        return key_said(event)
    if event.action.startswith("job."):
        return job_said(session, event)
    if event.action == "model.base_change":
        return base_change_said(session, event)
    sentence = SENTENCES.get(event.action)
    return sentence(owner, event) if sentence is not None else Said(humanised(event.action))


def candidates(owner: Owner) -> ColumnElement[bool]:
    text = cast(AuditEvent.detail, String)
    mentioned = text.contains(f'"{owner.key}"', autoescape=True)
    targeted = AuditEvent.target == owner.key
    if owner.custom:
        targeted = or_(targeted, AuditEvent.target.like(f"{owner.key}@%"))
    related = or_(AuditEvent.action.like("key.%"), AuditEvent.action.like("job.%"))
    return or_(targeted, and_(related, mentioned))


def belongs(owner: Owner, event: AuditEvent) -> bool:
    detail: dict[str, Any] = event.detail or {}
    if event.action.startswith("key."):
        return owner.key in (detail.get("models") or [])
    if event.action.startswith("job."):
        return detail.get("model") == owner.key
    return event.target == owner.key or (owner.custom and event.target.startswith(f"{owner.key}@"))


def event_of(session: Session, owner: Owner, event: AuditEvent) -> ModelActivityEvent:
    sentence = said(session, owner, event)
    return ModelActivityEvent(
        id=event.id,
        at=aware(event.at),
        actor=event.actor,
        action=event.action,
        text=sentence.text,
        link=sentence.link,
        tone=sentence.tone,
    )


def activity_of(session: Session, name: str, limit: int) -> ModelActivity:
    owner = owner_of(session, name)
    query = select(AuditEvent).where(candidates(owner)).order_by(AuditEvent.id.desc())
    found = [event for event in session.scalars(query) if belongs(owner, event)]
    return ModelActivity(events=[event_of(session, owner, event) for event in found[:limit]], total=len(found))


@router.get(
    "/model-pages/{name}/activity",
    dependencies=[Depends(viewer)],
    summary="List what changed on a model",
    description="Audited changes to the model, its versions, its keys and its jobs, newest first, as sentences.",
)
def read_model_activity(
    name: str, session: SessionDep, limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT
) -> ModelActivity:
    return activity_of(session, name, limit)
