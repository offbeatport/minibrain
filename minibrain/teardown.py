import logging
import shutil
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
from sqlalchemy import ColumnElement, select, update
from sqlalchemy.orm import Session, sessionmaker

from minibrain.data.dataset_versions import cleanup
from minibrain.gateway.config import LocalConfig, served_bases
from minibrain.jobs.removal import Leftovers, remove_job
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
    RequestLog,
    Teardown,
    TeardownKind,
    TeardownStatus,
    TeardownStep,
    Version,
    VersionKind,
    VersionStatus,
    now,
)
from minibrain.registry.service import ConflictError, adapter_name, reserve_name
from minibrain.serve.engines import DRAIN_TIMEOUT, drain_engine
from minibrain.settings import Settings
from minibrain.tasks.service import serving_base
from minibrain.worker import HttpClient

STOP_TIMEOUT = timedelta(minutes=10)
TICK_SECONDS = 1.0
ERROR_LENGTH = 500
STARTED = {
    TeardownKind.DELETE: "model.delete",
    TeardownKind.UNDEPLOY: "model.undeploy",
}
FINISHED = {kind: f"{action}_finished" for kind, action in STARTED.items()}
KIND_NAMES = {
    "train": "Train",
    "eval": "Score",
    "judge": "Judge",
    "download": "Download",
    "import": "Import",
    "verify": "Verify",
    "repair": "Repair",
    "catalog_sync": "Catalogue sync",
}

Cancel = Callable[[Job], None]

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
    serving = serving_base(model)
    if everything:
        routes = [model.slug, *(f"{model.slug}@{version.number}" for version in model.versions)]
        adapters = lora_adapters(model)
        bases = sorted({serving, *(version.base_model for version in model.versions)})
    else:
        routes = [model.slug]
        adapters = lora_adapters(model, {current}) if current is not None else []
        bases = [serving]
    return {
        "custom": True,
        "slug": model.slug,
        "routes": routes,
        "adapters": adapters,
        "base": serving,
        "bases": bases,
        "version": current,
    }


def base_targets(base: BaseModel) -> dict[str, Any]:
    return {"custom": False, "slug": base.id, "routes": [base.id], "adapters": [], "base": base.id}


def kind_name(kind: str) -> str:
    return KIND_NAMES.get(kind, kind)


def job_label(job: Job) -> str:
    owner = job.model_name or job.model_slug or job.base_model_key or f"Job #{job.id}"
    version = f" v{job.version_number}" if job.version_number is not None else ""
    return f"{owner}{version}: {kind_name(job.kind)}, {job.status}"


def job_fact(job: Job) -> dict[str, Any]:
    return {
        "id": job.id,
        "label": job_label(job),
        "kind": job.kind,
        "status": job.status,
        "model": job.model_slug,
        "version": job.version_number,
        "base_model": job.base_model_key,
    }


class JobsRunningError(ConflictError):
    def __init__(self, message: str, jobs: list[Job]) -> None:
        super().__init__(f"{message} ({'; '.join(job_label(job) for job in jobs)})")
        self.jobs = [job_fact(job) for job in jobs]


def active_jobs(session: Session, owner: ColumnElement[bool]) -> list[Job]:
    query = select(Job).where(owner, Job.status.in_(ACTIVE_JOB_STATUSES)).order_by(Job.id)
    return list(session.scalars(query))


def still_active(jobs: list[Job]) -> list[int]:
    return [job.id for job in jobs if job.status in ACTIVE_JOB_STATUSES]


def uncancelled(jobs: list[Job]) -> list[Job]:
    return [job for job in jobs if not job.cancel_requested]


def a_job_running(name: str, jobs: list[Job]) -> str:
    if len(jobs) == 1:
        return f"{name} has a job running; cancel it first"
    return f"{name} has {len(jobs)} jobs running; cancel them first"


def stop_jobs(jobs: list[Job], cancel: Cancel | None, refusal: str) -> None:
    pending = uncancelled(jobs)
    if not pending:
        return
    if cancel is None:
        raise JobsRunningError(refusal, pending)
    for job in pending:
        cancel(job)


def model_jobs(session: Session, model: Model) -> list[Job]:
    return active_jobs(session, Job.model_id == model.id)


def version_jobs(session: Session, version: Version) -> list[Job]:
    return active_jobs(session, Job.version_id == version.id)


def base_jobs(session: Session, base: BaseModel) -> list[Job]:
    return active_jobs(session, Job.base_model_id == base.id)


def version_ids_with_jobs(session: Session) -> list[int]:
    query = select(Job.version_id).where(Job.version_id.is_not(None), Job.status.in_(ACTIVE_JOB_STATUSES))
    return [version_id for version_id in session.scalars(query) if version_id is not None]


def remove_version(session: Session, settings: Settings, version: Version) -> int:
    session.delete(version)
    session.flush()
    return cleanup(session, settings)


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
    teardown.detail = {
        key: value for key, value in teardown.detail.items() if key not in ("waiting", "release", "jobs")
    }
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
    session: Session,
    model: Model,
    actor: str,
    undeploy: bool = False,
    parent: Teardown | None = None,
    cancel: Cancel | None = None,
) -> Teardown:
    existing = model.teardown
    jobs = model_jobs(session, model)
    refusal = a_job_running(model.name, uncancelled(jobs))
    if existing is not None and existing.kind == TeardownKind.DELETE:
        if parent is not None:
            existing.parent_id = parent.id
        if existing.status == TeardownStatus.FAILED:
            stop_jobs(jobs, cancel, refusal)
            return restart(session, existing, actor)
        if cancel is not None:
            stop_jobs(jobs, cancel, refusal)
        return existing
    stopping = existing is not None and existing.status == TeardownStatus.RUNNING
    if model.deployed and not undeploy:
        raise ConflictError(f"{model.name} is deployed; undeploy it first")
    stop_jobs(jobs, cancel, refusal)
    live = model.deployed or stopping
    if existing is not None:
        drop(session, existing)
    detail = custom_targets(model, everything=True) | {"live": live, "jobs": still_active(jobs)}
    model.deployed = False
    model.updated_at = now()
    facts: dict[str, Any] = {"name": model.name, "kind": "custom", "versions": len(model.versions), "undeploy": live}
    if jobs:
        facts["jobs"] = [job.id for job in jobs]
    if parent is not None:
        facts["with_base"] = parent.name
    session.add(AuditEvent(actor=actor, action="model.delete", target=model.slug, detail=facts))
    return begin(session, TeardownKind.DELETE, actor, model.name, detail, model=model, parent=parent)


def dependents_of(session: Session, base: BaseModel) -> list[Model]:
    models = session.scalars(select(Model).order_by(Model.name))
    return [model for model in models if base.id in (model.base_model, serving_base(model) if model.deployed else "")]


class NewDependentsError(ConflictError):
    def __init__(self, added: list[str], base: str) -> None:
        super().__init__(f"{names(added)} {are(added)} built on {base} now; delete them first")
        self.added = added


def dependent_jobs(session: Session, dependents: list[Model]) -> list[Job]:
    return active_jobs(session, Job.model_id.in_([model.id for model in dependents])) if dependents else []


def stop_base_jobs(
    session: Session, base: BaseModel, dependents: list[Model], cascade: bool, cancel: Cancel | None
) -> list[Job]:
    own = base_jobs(session, base)
    theirs = dependent_jobs(session, dependents) if cascade else []
    stop_jobs(own, cancel, a_job_running(base.name, uncancelled(own)))
    busy_ids = {job.model_id for job in uncancelled(theirs)}
    busy = [model.name for model in dependents if model.id in busy_ids]
    stop_jobs(theirs, cancel, f"{names(busy)} {'has' if len(busy) == 1 else 'have'} a job running; cancel it first")
    return own + theirs


def delete_base(
    session: Session,
    base: BaseModel,
    actor: str,
    cascade: bool = False,
    undeploy: bool = False,
    cancel: Cancel | None = None,
) -> Teardown:
    existing = base.teardown
    dependents = dependents_of(session, base)
    if existing is not None and existing.kind == TeardownKind.DELETE:
        if existing.status != TeardownStatus.FAILED:
            if cancel is not None:
                stop_base_jobs(session, base, dependents, cascade, cancel)
            return existing
        if bool(existing.detail.get("cascade")) != cascade:
            raise ConflictError(f"deleting {base.name} with the models built on it failed; retry it with cascade=true")
        current = sorted(model.name for model in dependents)
        if not cascade or current == sorted(existing.detail.get("models") or []):
            stop_base_jobs(session, base, dependents, cascade, cancel)
            return restart(session, existing, actor)
    running = existing is not None and existing.status == TeardownStatus.RUNNING
    built = [model.name for model in dependents]
    if built and not cascade:
        raise ConflictError(
            f"{names(built)} {are(built)} trained on {base.name}; delete them first, or delete them with it "
            "(cascade=true)"
        )
    if cancel is None:
        stop_base_jobs(session, base, dependents, cascade, None)
    live = [model.name for model in dependents if model.deployed]
    if base.deployed and not undeploy:
        raise ConflictError(f"{base.name} is deployed; undeploy it first")
    if live and not undeploy:
        them = "it" if len(live) == 1 else "them"
        raise ConflictError(f"{names(live)} {are(live)} live; pass undeploy=true to stop {them}")
    stopping = existing is not None and running and existing.kind == TeardownKind.UNDEPLOY
    stopped = stop_base_jobs(session, base, dependents, cascade, cancel)
    if existing is not None:
        drop(session, existing)
    detail = base_targets(base) | {
        "cascade": cascade,
        "models": built,
        "live": len(live) + int(base.deployed or stopping),
        "undeploy": undeploy,
        "jobs": still_active([job for job in stopped if job.base_model_id == base.id]),
    }
    facts: dict[str, Any] = {"name": base.name, "kind": "base", "size_bytes": base.size_bytes}
    facts |= {"kept": base.path} if base.path else {}
    facts |= {"cascade": [model.slug for model in dependents]} if cascade else {}
    facts |= {"jobs": [job.id for job in stopped]} if stopped else {}
    base.deployed = False
    base.updated_at = now()
    session.add(AuditEvent(actor=actor, action="model.delete", target=base.id, detail=facts))
    teardown = begin(session, TeardownKind.DELETE, actor, base.name, detail, base_model=base)
    for model in dependents:
        delete_custom(session, model, actor, undeploy=True, parent=teardown, cancel=cancel)
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


def changed(result: object) -> int:
    return int(getattr(result, "rowcount", 0) or 0)


def keep_custom_history(session: Session, model: Model) -> dict[str, int]:
    owner = {"model_slug": model.slug, "model_name": model.name}
    jobs = session.execute(update(Job).where(Job.model_id == model.id).values(owner))
    logs = session.execute(update(RequestLog).where(RequestLog.model_id == model.id).values(owner))
    return {"jobs": changed(jobs), "request_logs": changed(logs)}


def keep_base_history(session: Session, base: BaseModel) -> dict[str, int]:
    jobs = session.execute(update(Job).where(Job.base_model_id == base.id).values(base_model_key=base.id))
    served = (RequestLog.model_id.is_(None), RequestLog.model_slug.is_(None), RequestLog.model == base.id)
    logs = session.execute(update(RequestLog).where(*served).values(model_name=base.name))
    return {"jobs": changed(jobs), "request_logs": changed(logs)}


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

    def finish_jobs(self) -> int:
        with self.sessions() as session:
            stopped = select(Job).where(Job.delete_requested.is_(True), Job.status.not_in(ACTIVE_JOB_STATUSES))
            leftovers = Leftovers()
            jobs = list(session.scalars(stopped))
            for job in jobs:
                leftovers.merge(remove_job(session, self.settings.work_dir(), job))
            session.commit()
        leftovers.clear(store_for(self.settings))
        return len(jobs)

    def run_once(self) -> int:
        self.finish_jobs()
        versions = self.finish_versions()
        if not self.active():
            return versions
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
        return len(ids) + versions

    def finish_versions(self) -> int:
        with self.sessions() as session:
            busy = set(version_ids_with_jobs(session))
            deleting = list(session.scalars(select(Version).where(Version.status == VersionStatus.DELETING)))
            for version in deleting:
                if version.id not in busy:
                    self.finish_version(session, version)
            return len(deleting)

    def finish_version(self, session: Session, version: Version) -> None:
        target = f"{version.model.slug}@{version.number}"
        started = session.scalar(
            select(AuditEvent)
            .where(AuditEvent.action == "version.delete", AuditEvent.target == target)
            .order_by(AuditEvent.id.desc())
            .limit(1)
        )
        name = version.model.name
        removed = remove_version(session, self.settings, version)
        facts = {"name": name, "outcome": "done", "dataset_versions": removed}
        if started is not None:
            facts["seconds"] = round((now() - started.at).total_seconds(), 1)
        actor = started.actor if started is not None else "minibrain"
        session.add(AuditEvent(actor=actor, action="version.delete_finished", target=target, detail=facts))
        session.commit()
        log.info("deleting %s finished", target)

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

    def job_waits(self, session: Session, teardown: Teardown) -> list[str]:
        if teardown.kind != TeardownKind.DELETE:
            return []
        owner = (
            Job.model_id == teardown.model_id
            if teardown.model_id is not None
            else Job.base_model_id == teardown.base_model_id
        )
        jobs = active_jobs(session, owner)
        ids = [job.id for job in jobs]
        if teardown.detail.get("jobs", []) != ids:
            teardown.detail = {**teardown.detail, "jobs": ids}
        if not jobs:
            return []
        listed = names([f"#{job.id} ({kind_name(job.kind)})" for job in jobs])
        return [f"{'job' if len(jobs) == 1 else 'jobs'} {listed} to stop"]

    def pending(self, session: Session, teardown: Teardown) -> list[str]:
        waiting = self.job_waits(session, teardown)
        if waiting:
            return waiting
        detail = teardown.detail
        routes = sorted(set(detail.get("routes") or []))
        adapters = list(detail.get("adapters") or [])
        bases = set(detail.get("bases") or [str(detail.get("base") or "")])
        for gateway in live_gateways(session):
            still = [route for route in routes if route in gateway.routes]
            if still:
                waiting.append(f"the gateway on {gateway.host} to stop routing {names(still)}")
        released: set[str] = set()
        for replica in live_engines(session):
            if replica.base_model not in bases:
                continue
            needed = self.needed(replica.base_model)
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
                released.add(replica.base_model)
                waiting.append(f"the engine on {host} to stop")
        if released and not detail.get("release"):
            teardown.detail = {**teardown.detail, "release": sorted(released)}
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
        kept = keep_custom_history(session, model)
        reserve_name(session, model.slug, "custom", model.name, record.actor)
        drop(session, teardown)
        session.delete(model)
        session.flush()
        removed["dataset_versions"] = cleanup(session, self.settings)
        removed["artifacts"] = drop_artifacts(session, self.settings, adapters)
        self.finish(session, record, removed=removed, history=kept)

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
        kept = keep_base_history(session, base)
        reserve_name(session, base.id, "base", base.name, record.actor)
        drop(session, teardown)
        session.delete(base)
        session.flush()
        objects += sweep_weights(session, store)
        removed |= {"bucket_objects": objects} if objects else {}
        self.finish(session, record, removed=removed, history=kept)

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
