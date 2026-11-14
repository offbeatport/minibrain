from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import ColumnElement, String, and_, cast, func, or_, select
from sqlalchemy.orm import Session

from minibrain.api.access import viewer
from minibrain.api.deps import SessionDep
from minibrain.api.request_logs import aware
from minibrain.registry.models import SYSTEM_ACTOR, AuditEvent, Job, JobKind, JobStatus, Model, User
from minibrain.registry.models import BaseModel as BaseRow
from minibrain.registry.service import no_model
from minibrain.tasks.service import held_out_score

router = APIRouter(prefix="/api")

LinkKind = Literal["model", "version", "job", "key", "base", "monitoring"]
Tone = Literal["neutral", "success", "failed"]
DEFAULT_LIMIT = 40
CREATING = ("model.create", "model.duplicate", "model.download", "model.import")
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
    actor_name: str | None
    action: str
    text: str
    link: ActivityLink | None
    tone: Tone
    score: float | None = None


class ModelActivity(BaseModel):
    events: list[ModelActivityEvent]
    total: int


@dataclass(frozen=True)
class Owner:
    key: str
    name: str
    custom: bool
    created_at: datetime
    made: int | None = None
    model_id: int | None = None


@dataclass(frozen=True)
class Said:
    text: str
    link: ActivityLink | None = None
    tone: Tone = "neutral"


def creation_event(session: Session, key: str) -> int | None:
    query = select(func.max(AuditEvent.id)).where(AuditEvent.target == key, AuditEvent.action.in_(CREATING))
    return session.scalar(query)


def owner_of(session: Session, name: str) -> Owner:
    custom = session.scalar(select(Model).where(Model.slug == name))
    if custom is not None:
        made = creation_event(session, custom.slug)
        return Owner(custom.slug, custom.name, True, custom.created_at, made, custom.id)
    base = session.get(BaseRow, name)
    if base is None:
        raise no_model(session, name)
    return Owner(base.id, base.name, False, base.created_at)


def this_instance(owner: Owner) -> ColumnElement[bool]:
    if owner.made is not None:
        return AuditEvent.id >= owner.made
    return AuditEvent.at >= owner.created_at


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
        return Said(f"deployed {name}", link, "success")
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


def feedback_said(event: AuditEvent) -> Said:
    _, _, number = event.target.rpartition("/")
    row = f"feedback row #{number}" if number.isdigit() else "a feedback row"
    verbs = {
        "feedback.accept": f"accepted {row}",
        "feedback.fix": f"corrected {row}",
        "feedback.reject": f"rejected {row}",
        "feedback.example": f"added {row} to the examples",
        "feedback.example_remove": f"removed {row} from the examples",
        "feedback.assign": f"assigned {row}",
        "feedback.unassign": f"unassigned {row}",
    }
    return Said(verbs.get(event.action, f"{humanised(event.action)} {row}"))


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


def downloaded(owner: Owner, event: AuditEvent) -> Said:
    name = detail_text(event, "name") or owner.name
    return Said(f"started downloading {name}", ActivityLink(kind="model", label=name, key=owner.key))


def imported(owner: Owner, event: AuditEvent) -> Said:
    name = detail_text(event, "name") or owner.name
    return Said(f"started importing {name}", ActivityLink(kind="model", label=name, key=owner.key))


def deployed(owner: Owner, event: AuditEvent) -> Said:
    return Said(f"deployed {owner.key}", ActivityLink(kind="monitoring", label=owner.key, key=owner.key), "success")


def undeployed(owner: Owner, event: AuditEvent) -> Said:
    return Said(f"undeployed {owner.key}")


def deleted(owner: Owner, event: AuditEvent) -> Said:
    return Said(f"deleted {owner.name}", None, "failed")


def kept(owner: Owner, event: AuditEvent) -> Said:
    return Said(f"turned keeping inputs and answers {'on' if (event.detail or {}).get('to') else 'off'}")


def rescored(owner: Owner, event: AuditEvent) -> Said:
    count = len((event.detail or {}).get("versions") or [])
    return Said(f"started re-scoring {count} version{'' if count == 1 else 's'}")


def updated(owner: Owner, event: AuditEvent) -> Said:
    return update_said(event)


SENTENCES: dict[str, Callable[[Owner, AuditEvent], Said]] = {
    "model.create": created,
    "model.duplicate": duplicated,
    "model.download": downloaded,
    "model.import": imported,
    "model.deploy": deployed,
    "model.undeploy": undeployed,
    "model.undeploy_finished": fixed("finished undeploying"),
    "model.delete": deleted,
    "model.instructions": fixed("changed the instructions"),
    "model.graders": fixed("changed the graders"),
    "model.promotion": fixed("changed the promotion rule"),
    "model.rescore": rescored,
    "model.contract": fixed("changed the answers"),
    "model.judge": fixed("changed the judge"),
    "model.safety": fixed("changed the safety model"),
    "model.labels_dismiss": fixed("dismissed the proposed labels"),
    "model.request_bodies": kept,
    "model.update": updated,
    "model.avatar": fixed("changed the avatar"),
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
    if event.action.startswith("feedback."):
        return feedback_said(event)
    if event.action == "model.base_change":
        return base_change_said(session, event)
    sentence = SENTENCES.get(event.action)
    return sentence(owner, event) if sentence is not None else Said(humanised(event.action))


def candidates(owner: Owner) -> ColumnElement[bool]:
    text = cast(AuditEvent.detail, String)
    mentioned = text.contains(f'"{owner.key}"', autoescape=True)
    targeted = AuditEvent.target == owner.key
    if owner.custom:
        own = or_(AuditEvent.target.like(f"{owner.key}@%"), AuditEvent.target.like(f"{owner.key}/feedback/%"))
        targeted = or_(targeted, own)
    related = or_(AuditEvent.action.like("key.%"), AuditEvent.action.like("job.%"))
    return and_(this_instance(owner), or_(targeted, and_(related, mentioned)))


def belongs(owner: Owner, event: AuditEvent) -> bool:
    detail: dict[str, Any] = event.detail or {}
    if event.action.startswith("key."):
        return owner.key in (detail.get("models") or [])
    if event.action.startswith("job."):
        return detail.get("model") == owner.key
    owned = event.target.startswith((f"{owner.key}@", f"{owner.key}/feedback/"))
    return event.target == owner.key or (owner.custom and owned)


def display_names(session: Session, actors: set[str]) -> dict[str, str]:
    if not actors:
        return {}
    query = select(User).where(or_(User.email.in_(actors), User.subject.in_(actors)))
    names: dict[str, str] = {}
    for user in session.scalars(query):
        for handle in (user.email, user.subject):
            if handle in actors and user.name and user.name != handle:
                names[handle] = user.name
    return names


def name_of(actor: str, names: dict[str, str]) -> str | None:
    if actor == SYSTEM_ACTOR:
        return None
    return names.get(actor) or actor.partition("@")[0] or actor


def failure_reason(job: Job) -> str:
    return ": out of memory" if "memory" in (job.error or "").lower() else ""


def outcome_of(job: Job, started: AuditEvent | None, names: dict[str, str]) -> ModelActivityEvent:
    number = job.version_number
    name = f"v{number}"
    failed = job.status == JobStatus.FAILED
    actor = SYSTEM_ACTOR if failed or started is None else started.actor
    if failed:
        text = f"{name} failed{failure_reason(job)}"
    else:
        text = f"{name} trained" if actor == SYSTEM_ACTOR else f"trained {name}"
    return ModelActivityEvent(
        id=-job.id,
        at=aware(job.finished_at or job.created_at),
        actor=actor,
        actor_name=name_of(actor, names),
        action="version.failed" if failed else "version.trained",
        text=text,
        link=ActivityLink(kind="version", label=name, version=number),
        tone="failed" if failed else "neutral",
        score=None if failed or job.version is None else held_out_score(job.version),
    )


def finished_training(session: Session, owner: Owner) -> list[Job]:
    if owner.model_id is None:
        return []
    query = select(Job).where(
        Job.model_id == owner.model_id,
        Job.kind == JobKind.TRAIN,
        Job.status.in_((JobStatus.SUCCEEDED, JobStatus.FAILED)),
        Job.version_number.is_not(None),
        Job.finished_at >= owner.created_at,
    )
    return list(session.scalars(query))


def starts_of(found: list[AuditEvent], jobs: list[Job]) -> dict[int, AuditEvent]:
    starts = {number_of(event.target): event for event in reversed(found) if event.action == "version.create"}
    return {
        job.id: starts[job.version_number]
        for job in jobs
        if job.status == JobStatus.SUCCEEDED and job.version_number in starts
    }


def event_of(session: Session, owner: Owner, event: AuditEvent, names: dict[str, str]) -> ModelActivityEvent:
    sentence = said(session, owner, event)
    return ModelActivityEvent(
        id=event.id,
        at=aware(event.at),
        actor=event.actor,
        actor_name=name_of(event.actor, names),
        action=event.action,
        text=sentence.text,
        link=sentence.link,
        tone=sentence.tone,
    )


def activity_of(session: Session, name: str, limit: int) -> ModelActivity:
    owner = owner_of(session, name)
    query = select(AuditEvent).where(candidates(owner)).order_by(AuditEvent.id.desc())
    found = [event for event in session.scalars(query) if belongs(owner, event)]
    jobs = finished_training(session, owner)
    starts = starts_of(found, jobs)
    merged = {event.id for event in starts.values()}
    kept = [event for event in found if event.id not in merged]
    moments = sorted(
        [(aware(event.at), event.id, event) for event in kept]
        + [(aware(job.finished_at or job.created_at), -job.id, job) for job in jobs],
        key=lambda entry: (entry[0], entry[1]),
        reverse=True,
    )[:limit]
    actors = {
        item.actor if isinstance(item, AuditEvent) else starts[item.id].actor
        for _, _, item in moments
        if isinstance(item, AuditEvent) or item.id in starts
    }
    names = display_names(session, actors)
    events = [
        event_of(session, owner, item, names)
        if isinstance(item, AuditEvent)
        else outcome_of(item, starts.get(item.id), names)
        for _, _, item in moments
    ]
    return ModelActivity(events=events, total=len(kept) + len(jobs))


@router.get(
    "/models/{name}/activity",
    dependencies=[Depends(viewer)],
    summary="List what changed on a model",
    description="Audited changes to the model, its versions, its keys and its jobs, newest first, as sentences.",
)
def read_model_activity(
    name: str, session: SessionDep, limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT
) -> ModelActivity:
    return activity_of(session, name, limit)
