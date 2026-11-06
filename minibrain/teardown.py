import logging
import shutil
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from minibrain.data.dataset_versions import cleanup
from minibrain.gateway.config import LocalConfig, served_bases
from minibrain.leader import Leader
from minibrain.models.bucket import drop_weights, sweep_weights
from minibrain.models.registry import model_dir
from minibrain.registry.compute import live_engines, live_gateways
from minibrain.registry.files import store_for
from minibrain.registry.models import (
    ACTIVE_JOB_STATUSES,
    Artifact,
    AuditEvent,
    BaseModel,
    DatasetVersion,
    Job,
    KeyScope,
    Model,
    Teardown,
    TeardownKind,
    TeardownStatus,
    TeardownStep,
    Version,
    VersionKind,
    now,
)
from minibrain.registry.service import ConflictError, adapter_name, drop_orphan_keys
from minibrain.serve.engines import DRAIN_TIMEOUT, drain_engine
from minibrain.settings import Settings
from minibrain.worker import HttpClient

STOP_TIMEOUT = timedelta(minutes=10)
TICK_SECONDS = 1.0
ERROR_LENGTH = 500
STARTED = {
    TeardownKind.DELETE: "model.delete",
    TeardownKind.UNDEPLOY: "model.undeploy",
}
FINISHED = {kind: f"{action}_finished" for kind, action in STARTED.items()}

log = logging.getLogger("minibrain.teardown")


def names(items: list[str]) -> str:
    if len(items) <= 1:
        return "".join(items)
    return f"{', '.join(items[:-1])} and {items[-1]}"


def are(items: list[str]) -> str:
    return "is" if len(items) == 1 else "are"


@dataclass(frozen=True)
class Record:
    kind: TeardownKind
    name: str
    actor: str
    target: str
    custom: bool
    started_at: datetime
    attempt: int
    models: tuple[str, ...]


def record_of(teardown: Teardown) -> Record:
    return Record(
        kind=TeardownKind(teardown.kind),
        name=teardown.name,
        actor=teardown.actor,
        target=str(teardown.detail.get("slug") or teardown.base_model_id or teardown.name),
        custom=bool(teardown.detail.get("custom")),
        started_at=teardown.started_at,
        attempt=teardown.attempt,
        models=tuple(teardown.detail.get("models") or ()),
    )


def audit(session: Session, record: Record, action: str, **detail: Any) -> None:
    facts = {"name": record.name, "kind": "custom" if record.custom else "base"} | detail
    session.add(AuditEvent(actor=record.actor, action=action, target=record.target, detail=facts))


def host_of(node_id: str) -> str:
    return node_id.split("/", 1)[-1]


def lora_adapters(model: Model, numbers: set[int] | None = None) -> list[str]:
    return [
        adapter_name(model.slug, version.number)
        for version in model.versions
        if version.kind == VersionKind.LORA
        and version.adapter_artifact_id is not None
        and (numbers is None or version.number in numbers)
    ]


def custom_targets(model: Model, everything: bool) -> dict[str, Any]:
    current = model.current_version
    if everything:
        routes = [model.slug, *(f"{model.slug}@{version.number}" for version in model.versions)]
        adapters = lora_adapters(model)
    else:
        routes = [model.slug]
        adapters = lora_adapters(model, {current}) if current is not None else []
    return {
        "custom": True,
        "slug": model.slug,
        "routes": routes,
        "adapters": adapters,
        "base": model.base_model,
        "version": current,
    }


def base_targets(base: BaseModel) -> dict[str, Any]:
    return {"custom": False, "slug": base.id, "routes": [base.id], "adapters": [], "base": base.id}


def running_jobs(model: Model) -> bool:
    return any(job.status in ACTIVE_JOB_STATUSES for job in model.jobs)


def begin(
    session: Session,
    kind: TeardownKind,
    actor: str,
    name: str,
    detail: dict[str, Any],
    model: Model | None = None,
    base_model: BaseModel | None = None,
    parent: Teardown | None = None,
) -> Teardown:
    teardown = Teardown(
        kind=kind,
        model_id=model.id if model is not None else None,
        base_model_id=base_model.id if base_model is not None else None,
        parent_id=parent.id if parent is not None else None,
        name=name,
        actor=actor,
        detail=detail,
        status=TeardownStatus.RUNNING,
        step=TeardownStep.STOPPING,
    )
    session.add(teardown)
    session.flush()
    for owner in (model, base_model):
        if owner is not None:
            session.expire(owner, ["teardown"])
    return teardown


def restart(session: Session, teardown: Teardown, actor: str) -> Teardown:
    teardown.status = TeardownStatus.RUNNING
    teardown.error = None
    teardown.attempt += 1
    teardown.actor = actor
    teardown.started_at = now()
    teardown.updated_at = now()
    teardown.detail = {key: value for key, value in teardown.detail.items() if key not in ("waiting", "release")}
    for child in session.scalars(select(Teardown).where(Teardown.parent_id == teardown.id)):
        if child.status == TeardownStatus.FAILED:
            restart(session, child, actor)
    record = record_of(teardown)
    audit(session, record, STARTED[record.kind], retry=teardown.attempt)
    return teardown


def drop(session: Session, teardown: Teardown) -> None:
    owners = (
        session.get(Model, teardown.model_id) if teardown.model_id is not None else None,
        session.get(BaseModel, teardown.base_model_id) if teardown.base_model_id is not None else None,
    )
    session.delete(teardown)
    session.flush()
    for owner in owners:
        if owner is not None:
            session.expire(owner, ["teardown"])


def being_deleted(name: str) -> ConflictError:
    return ConflictError(f"{name} is being deleted")


def require_idle(teardown: Teardown | None, name: str) -> None:
    if teardown is None or teardown.kind == TeardownKind.UNDEPLOY:
        return
    raise being_deleted(name)


def undeploy_custom(session: Session, model: Model, actor: str) -> Teardown | None:
    existing = model.teardown
    if existing is not None and existing.kind != TeardownKind.UNDEPLOY:
        raise being_deleted(model.name)
    if existing is not None:
        return restart(session, existing, actor) if existing.status == TeardownStatus.FAILED else existing
    if not model.deployed:
        return None
    detail = custom_targets(model, everything=False)
    model.deployed = False
    model.updated_at = now()
    facts = {"name": model.name, "version": model.current_version}
    session.add(AuditEvent(actor=actor, action="model.undeploy", target=model.slug, detail=facts))
    return begin(session, TeardownKind.UNDEPLOY, actor, model.name, detail, model=model)


def undeploy_base(session: Session, base: BaseModel, actor: str) -> Teardown | None:
    existing = base.teardown
    if existing is not None and existing.kind == TeardownKind.DELETE:
        raise being_deleted(base.name)
    if existing is not None and existing.kind == TeardownKind.UNDEPLOY:
        return restart(session, existing, actor) if existing.status == TeardownStatus.FAILED else existing
    if not base.deployed:
        return None
    base.deployed = False
    base.updated_at = now()
    session.add(AuditEvent(actor=actor, action="model.undeploy", target=base.id, detail={"name": base.name}))
    if existing is not None:
        return existing
    return begin(session, TeardownKind.UNDEPLOY, actor, base.name, base_targets(base), base_model=base)


def cancel_stop(session: Session, teardown: Teardown | None, name: str) -> None:
    if teardown is None:
        return
    if teardown.kind != TeardownKind.UNDEPLOY:
        raise being_deleted(name)
    drop(session, teardown)


def delete_custom(
    session: Session, model: Model, actor: str, undeploy: bool = False, parent: Teardown | None = None
) -> Teardown:
    existing = model.teardown
    if existing is not None and existing.kind == TeardownKind.DELETE:
        if parent is not None:
            existing.parent_id = parent.id
        if existing.status == TeardownStatus.FAILED:
            return restart(session, existing, actor)
        return existing
    stopping = existing is not None and existing.status == TeardownStatus.RUNNING
    if model.deployed and not undeploy:
        raise ConflictError(f"{model.name} is deployed; undeploy it first")
    if running_jobs(model):
        raise ConflictError("cancel the running jobs first")
    live = model.deployed or stopping
    if existing is not None:
        drop(session, existing)
    detail = custom_targets(model, everything=True) | {"live": live}
    model.deployed = False
    model.updated_at = now()
    facts = {"name": model.name, "kind": "custom", "versions": len(model.versions), "undeploy": live}
    if parent is not None:
        facts["with_base"] = parent.name
    session.add(AuditEvent(actor=actor, action="model.delete", target=model.slug, detail=facts))
    return begin(session, TeardownKind.DELETE, actor, model.name, detail, model=model, parent=parent)


def dependents_of(session: Session, base: BaseModel) -> list[Model]:
    return list(session.scalars(select(Model).where(Model.base_model == base.id).order_by(Model.name)))


class NewDependentsError(ConflictError):
    def __init__(self, added: list[str], base: str) -> None:
        super().__init__(f"{names(added)} {are(added)} built on {base} now; delete them first")
        self.added = added


def base_job_running(session: Session, base: BaseModel) -> bool:
    query = select(Job.id).where(Job.base_model_id == base.id, Job.status.in_(ACTIVE_JOB_STATUSES)).limit(1)
    return session.scalar(query) is not None


def delete_base(
    session: Session, base: BaseModel, actor: str, cascade: bool = False, undeploy: bool = False
) -> Teardown:
    existing = base.teardown
    if existing is not None and existing.kind == TeardownKind.DELETE:
        if existing.status != TeardownStatus.FAILED:
            return existing
        if bool(existing.detail.get("cascade")) != cascade:
            raise ConflictError(f"deleting {base.name} with the models built on it failed; retry it with cascade=true")
        current = sorted(model.name for model in dependents_of(session, base))
        if not cascade or current == sorted(existing.detail.get("models") or []):
            return restart(session, existing, actor)
    running = existing is not None and existing.status == TeardownStatus.RUNNING
    if base_job_running(session, base):
        raise ConflictError(f"{base.name} has a download or import running; cancel it first")
    dependents = dependents_of(session, base)
    built = [model.name for model in dependents]
    if built and not cascade:
        raise ConflictError(
            f"{names(built)} {are(built)} trained on {base.name}; delete them first, or delete them with it "
            "(cascade=true)"
        )
    busy = [model.name for model in dependents if running_jobs(model)]
    if busy:
        raise ConflictError(f"{names(busy)} {'has' if len(busy) == 1 else 'have'} a job running; cancel it first")
    live = [model.name for model in dependents if model.deployed]
    if base.deployed and not undeploy:
        raise ConflictError(f"{base.name} is deployed; undeploy it first")
    if live and not undeploy:
        them = "it" if len(live) == 1 else "them"
        raise ConflictError(f"{names(live)} {are(live)} live; pass undeploy=true to stop {them}")
    stopping = existing is not None and running and existing.kind == TeardownKind.UNDEPLOY
    if existing is not None:
        drop(session, existing)
    detail = base_targets(base) | {
        "cascade": cascade,
        "models": built,
        "live": len(live) + int(base.deployed or stopping),
        "undeploy": undeploy,
    }
    facts: dict[str, Any] = {"name": base.name, "kind": "base", "size_bytes": base.size_bytes}
    facts |= {"kept": base.path} if base.path else {}
    facts |= {"cascade": [model.slug for model in dependents]} if cascade else {}
    base.deployed = False
    base.updated_at = now()
    session.add(AuditEvent(actor=actor, action="model.delete", target=base.id, detail=facts))
    teardown = begin(session, TeardownKind.DELETE, actor, base.name, detail, base_model=base)
    for model in dependents:
        delete_custom(session, model, actor, undeploy=True, parent=teardown)
    return teardown


def remove_folder(folder: Path) -> None:
    if not folder.exists():
        return
    try:
        shutil.rmtree(folder)
    except OSError as error:
        raise OSError(f"could not remove {error.filename or folder}: {error.strerror or error}") from error


def drop_artifacts(session: Session, settings: Settings, candidates: set[str]) -> int:
    session.flush()
    store = store_for(settings)
    dropped = 0
    for artifact_id in sorted(candidates):
        if session.scalar(select(Version.id).where(Version.adapter_artifact_id == artifact_id).limit(1)) is not None:
            continue
        if (
            session.scalar(select(DatasetVersion.id).where(DatasetVersion.artifact_id == artifact_id).limit(1))
            is not None
        ):
            continue
        found = session.get(Artifact, artifact_id)
        if found is not None:
            session.delete(found)
        store.delete(artifact_id)
        dropped += 1
    return dropped


def short(error: Exception) -> str:
    text = str(error).splitlines()[0] if str(error) else type(error).__name__
    return text[:ERROR_LENGTH]


class Teardowns:
    def __init__(
        self,
        sessions: sessionmaker[Session],
        settings: Settings,
        config: LocalConfig | None = None,
        http: HttpClient | None = None,
    ) -> None:
        self.sessions = sessions
        self.settings = settings
        self.config = config
        self.http: HttpClient = http or httpx.Client(timeout=DRAIN_TIMEOUT)
        self.woken = threading.Event()

    def wake(self) -> None:
        self.woken.set()

    def active(self) -> bool:
        with self.sessions() as session:
            found = select(Teardown.id).where(Teardown.status == TeardownStatus.RUNNING).limit(1)
            return session.scalar(found) is not None

    def run_once(self) -> int:
        if not self.active():
            return 0
        if self.config is not None:
            self.config.rebuild()
        with self.sessions() as session:
            query = (
                select(Teardown.id)
                .where(Teardown.status == TeardownStatus.RUNNING)
                .order_by(Teardown.parent_id.is_(None), Teardown.id)
            )
            ids = list(session.scalars(query))
        for teardown_id in ids:
            with self.sessions() as session:
                teardown = session.get(Teardown, teardown_id)
                if teardown is not None and teardown.status == TeardownStatus.RUNNING:
                    self.advance(session, teardown)
        return len(ids)

    def forever(self, stop: threading.Event, leader: Leader) -> None:
        while not stop.wait(TICK_SECONDS):
            self.woken.clear()
            try:
                if leader.held():
                    self.run_once()
            except Exception:
                log.exception("model teardown check failed")

    def advance(self, session: Session, teardown: Teardown) -> None:
        children = list(session.scalars(select(Teardown).where(Teardown.parent_id == teardown.id)))
        running = [child for child in children if child.status == TeardownStatus.RUNNING]
        if running:
            count = f"the {len(running)} models" if len(running) > 1 else "the model"
            self.note(session, teardown, [f"{count} built on it to be deleted"])
            return
        failed = next((child for child in children if child.status == TeardownStatus.FAILED), None)
        if failed is not None:
            self.fail(session, teardown, f"{failed.name} could not be deleted: {failed.error}")
            return
        if teardown.step == TeardownStep.STOPPING:
            waiting = self.pending(session, teardown)
            if waiting and now() - teardown.started_at > STOP_TIMEOUT:
                minutes = int(STOP_TIMEOUT.total_seconds() // 60)
                self.fail(session, teardown, f"Still waiting after {minutes} minutes for {'; '.join(waiting)}.")
                return
            if waiting:
                self.note(session, teardown, waiting)
                return
            if teardown.kind == TeardownKind.UNDEPLOY:
                record = record_of(teardown)
                stopped = {"routes": teardown.detail.get("routes", []), "adapters": teardown.detail.get("adapters", [])}
                drop(session, teardown)
                self.finish(session, record, stopped=stopped)
                return
            teardown.step = TeardownStep.REMOVING
            self.note(session, teardown, [])
        try:
            self.remove(session, teardown)
        except Exception as error:
            session.rollback()
            log.warning("removing %s failed: %s", teardown.name, error)
            found = session.get(Teardown, teardown.id)
            if found is not None:
                if isinstance(error, NewDependentsError):
                    found.detail = {**found.detail, "added": error.added}
                self.fail(session, found, short(error))

    def note(self, session: Session, teardown: Teardown, waiting: list[str]) -> None:
        if teardown.detail.get("waiting", []) != waiting:
            teardown.detail = {**teardown.detail, "waiting": waiting}
            teardown.updated_at = now()
        session.commit()

    def needed(self, base: str) -> bool:
        if self.config is None:
            return True
        return base in served_bases(self.config.current())

    def pending(self, session: Session, teardown: Teardown) -> list[str]:
        detail = teardown.detail
        routes = sorted(set(detail.get("routes") or []))
        adapters = list(detail.get("adapters") or [])
        base = str(detail.get("base") or "")
        waiting: list[str] = []
        for gateway in live_gateways(session):
            still = [route for route in routes if route in gateway.routes]
            if still:
                waiting.append(f"the gateway on {gateway.host} to stop routing {names(still)}")
        needed = self.needed(base)
        release = False
        for replica in live_engines(session):
            if replica.base_model != base:
                continue
            host = host_of(replica.node_id)
            try:
                report = drain_engine(self.http, replica.url, routes, adapters)
            except Exception as error:
                waiting.append(f"the engine on {host} to answer ({short(error)})")
                continue
            if report.get("in_flight"):
                waiting.append(f"the engine on {host} to finish {report['in_flight']} requests in flight")
            elif report.get("loaded"):
                waiting.append(f"the engine on {host} to unload {names(list(report['loaded']))}")
            elif replica.managed and not needed and report.get("total"):
                waiting.append(f"the engine on {host} to finish {report['total']} requests in flight")
            elif replica.managed and not needed:
                release = True
                waiting.append(f"the engine on {host} to stop")
        if release and not detail.get("release"):
            teardown.detail = {**teardown.detail, "release": True}
        return waiting

    def remove(self, session: Session, teardown: Teardown) -> None:
        if teardown.model_id is not None:
            self.delete_custom(session, teardown)
        else:
            self.delete_base(session, teardown)

    def delete_custom(self, session: Session, teardown: Teardown) -> None:
        record = record_of(teardown)
        model = session.get(Model, teardown.model_id)
        if model is None:
            drop(session, teardown)
            self.finish(session, record)
            return
        adapters = {version.adapter_artifact_id for version in model.versions if version.adapter_artifact_id}
        removed = {"versions": len(model.versions), "key_scopes": len(model.key_scopes)}
        drop(session, teardown)
        session.delete(model)
        session.flush()
        drop_orphan_keys(session)
        removed["dataset_versions"] = cleanup(session, self.settings)
        removed["artifacts"] = drop_artifacts(session, self.settings, adapters)
        self.finish(session, record, removed=removed)

    def delete_base(self, session: Session, teardown: Teardown) -> None:
        record = record_of(teardown)
        base = session.get(BaseModel, teardown.base_model_id)
        if base is None:
            drop(session, teardown)
            self.finish(session, record)
            return
        added = [model.name for model in dependents_of(session, base)]
        if added:
            raise NewDependentsError(added, base.name)
        remove_folder(model_dir(self.settings, base.id))
        store = store_for(self.settings)
        objects = drop_weights(session, store, base)
        scopes = session.query(KeyScope).filter(KeyScope.base_model_id == base.id).delete()
        removed = {"size_bytes": base.size_bytes, "key_scopes": scopes, "models": teardown.detail.get("models", [])}
        removed |= {"kept": base.path} if base.path else {}
        drop(session, teardown)
        session.delete(base)
        session.flush()
        objects += sweep_weights(session, store)
        removed |= {"bucket_objects": objects} if objects else {}
        drop_orphan_keys(session)
        self.finish(session, record, removed=removed)

    def fail(self, session: Session, teardown: Teardown, error: str) -> None:
        teardown.status = TeardownStatus.FAILED
        teardown.error = error[:ERROR_LENGTH]
        teardown.detail = {key: value for key, value in teardown.detail.items() if key not in ("waiting", "release")}
        teardown.updated_at = now()
        self.audit_finished(session, record_of(teardown), "failed", error=teardown.error)
        session.commit()
        log.warning("%s of %s failed: %s", teardown.kind, teardown.name, teardown.error)

    def finish(self, session: Session, record: Record, **facts: Any) -> None:
        self.audit_finished(session, record, "done", **facts)
        session.commit()
        log.info("%s of %s finished", record.kind, record.name)

    def audit_finished(self, session: Session, record: Record, outcome: str, **facts: Any) -> None:
        seconds = round((now() - record.started_at).total_seconds(), 1)
        detail: dict[str, Any] = {"outcome": outcome, "seconds": seconds, "attempt": record.attempt} | facts
        if record.models:
            detail["models"] = list(record.models)
        audit(session, record, FINISHED[record.kind], **detail)
