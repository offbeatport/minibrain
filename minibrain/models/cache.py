import logging
import shutil
import threading
import time
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from minibrain.leader import Leader
from minibrain.models.health import content_hash, listed
from minibrain.models.registry import model_dir
from minibrain.registry.compute import live_engines
from minibrain.registry.models import (
    ACTIVE_JOB_STATUSES,
    AuditEvent,
    Job,
    Minibrain,
    Model,
    ModelStatus,
    Version,
    now,
)
from minibrain.registry.settings_store import read, write
from minibrain.settings import Settings
from minibrain.storage import GIB, size_text

KEY = "models.cache"
AUTOMATIC = "system"
RECENT = timedelta(hours=1)
TOUCH_EVERY = timedelta(minutes=5)
CHECK_SECONDS = 3600.0
POLL_SECONDS = 5.0

log = logging.getLogger("minibrain.models")


@dataclass(frozen=True)
class CacheSettings:
    enabled: bool = False
    budget_gb: float = 100.0

    @property
    def budget_bytes(self) -> int:
        return int(self.budget_gb * GIB)


def load_settings(session: Session) -> CacheSettings:
    stored = read(session, KEY, {}) or {}
    known = {name: stored[name] for name in asdict(CacheSettings()) if name in stored}
    return replace(CacheSettings(), **known)


def save_settings(session: Session, changes: dict[str, Any]) -> CacheSettings:
    updated = replace(load_settings(session), **changes)
    write(session, KEY, asdict(updated))
    return updated


@dataclass(frozen=True)
class CachedBase:
    key: str
    name: str
    size_bytes: int
    last_used_at: datetime
    pinned: bool
    kept: tuple[str, ...]

    @property
    def evictable(self) -> bool:
        return not self.kept


@dataclass(frozen=True)
class CachePlan:
    settings: CacheSettings
    used: int
    incoming: int
    evict: tuple[CachedBase, ...]

    @property
    def freed(self) -> int:
        return sum(base.size_bytes for base in self.evict)

    @property
    def after(self) -> int:
        return self.used + self.incoming - self.freed

    @property
    def over(self) -> bool:
        return self.settings.enabled and self.used + self.incoming > self.settings.budget_bytes

    @property
    def still_over(self) -> bool:
        return self.settings.enabled and self.after > self.settings.budget_bytes


def last_used(model: Model) -> datetime:
    return model.last_used_at or model.created_at


def touch(session: Session, key: str) -> None:
    model = session.get(Model, key)
    if model is None:
        return
    moment = now()
    if model.last_used_at is None or moment - model.last_used_at >= TOUCH_EVERY:
        model.last_used_at = moment


def names(items: list[str]) -> str:
    return listed(sorted(set(items)), limit=2)


def usage(session: Session, models: list[Model]) -> dict[str, list[str]]:
    reasons: dict[str, list[str]] = {model.id: [] for model in models}
    customs: dict[str, list[str]] = {}
    for name, base in session.execute(select(Minibrain.name, Minibrain.base_model)):
        customs.setdefault(base, []).append(name)
    hashes = {content_hash(model.files): model.id for model in models if model.files}
    trained: dict[str, list[str]] = {}
    query = select(Minibrain.name, Minibrain.base_model, Version.base_hash).join(Version.minibrain)
    for name, base, digest in session.execute(query.where(Version.base_hash.is_not(None))):
        owner = hashes.get(digest)
        if owner is not None and owner != base:
            trained.setdefault(owner, []).append(name)
    jobs = session.execute(
        select(Job.model_id, Job.kind).where(Job.model_id.is_not(None), Job.status.in_(ACTIVE_JOB_STATUSES))
    )
    running = {model_id: kind for model_id, kind in jobs}
    loaded = {replica.base_model for replica in live_engines(session)}
    moment = now()
    for model in models:
        found = reasons[model.id]
        if model.id in customs:
            found.append(f"Base of {names(customs[model.id])}")
        if model.id in trained:
            found.append(f"Versions of {names(trained[model.id])} were trained on it")
        if model.deployed:
            found.append("Deployed")
        if model.id in running:
            found.append(f"A {running[model.id]} job is running")
        if model.id in loaded:
            found.append("Loaded by an engine")
        if model.pinned:
            found.append("Pinned")
        if moment - last_used(model) < RECENT:
            found.append("Used in the last hour")
    return reasons


def cached_models(session: Session) -> list[Model]:
    query = select(Model).where(Model.status == ModelStatus.AVAILABLE, Model.path.is_(None))
    return list(session.scalars(query))


def cached_bases(session: Session) -> list[CachedBase]:
    models = cached_models(session)
    reasons = usage(session, models)
    bases = [
        CachedBase(
            key=model.id,
            name=model.name,
            size_bytes=model.size_bytes,
            last_used_at=last_used(model),
            pinned=model.pinned,
            kept=tuple(reasons[model.id]),
        )
        for model in models
    ]
    return sorted(bases, key=lambda base: base.last_used_at)


def plan(bases: list[CachedBase], settings: CacheSettings, incoming: int = 0) -> CachePlan:
    used = sum(base.size_bytes for base in bases)
    excess = used + incoming - settings.budget_bytes
    chosen: list[CachedBase] = []
    if settings.enabled:
        for base in sorted(bases, key=lambda item: item.last_used_at):
            if excess <= 0:
                break
            if base.evictable:
                chosen.append(base)
                excess -= base.size_bytes
    return CachePlan(settings=settings, used=used, incoming=incoming, evict=tuple(chosen))


def estimate(session: Session, incoming: int) -> CachePlan:
    return plan(cached_bases(session), load_settings(session), incoming)


def remove(session: Session, settings: Settings, found: CachePlan, trigger: str, actor: str) -> None:
    budget = found.settings.budget_bytes
    for base in found.evict:
        model = session.get(Model, base.key)
        if model is None:
            continue
        model.status = ModelStatus.EVICTED
        model.evicted_at = now()
        model.updated_at = now()
        detail = {
            "name": model.name,
            "size_bytes": base.size_bytes,
            "last_used_at": base.last_used_at.isoformat(),
            "budget_bytes": budget,
            "used_bytes": found.used,
            "trigger": trigger,
        }
        session.add(AuditEvent(actor=actor, action="model.evict", target=model.id, detail=detail))
        log.info(
            "removed %s (%s, last used %s) to keep base models under the %s budget",
            model.id,
            size_text(base.size_bytes),
            base.last_used_at.date().isoformat(),
            size_text(budget),
        )
    session.commit()
    for base in found.evict:
        shutil.rmtree(model_dir(settings, base.key), ignore_errors=True)


def evict(session: Session, settings: Settings, trigger: str, actor: str = AUTOMATIC) -> CachePlan:
    found = estimate(session, 0)
    if found.evict:
        remove(session, settings, found, trigger, actor)
    if found.still_over:
        log.warning(
            "base models use %s of the %s budget; the rest are in use or pinned",
            size_text(found.after),
            size_text(found.settings.budget_bytes),
        )
    return found


class CacheKeeper:
    def __init__(self, sessions: sessionmaker[Session], settings: Settings) -> None:
        self.sessions = sessions
        self.settings = settings
        self.woken = threading.Event()

    def wake(self) -> None:
        self.woken.set()

    def run(self, trigger: str, actor: str = AUTOMATIC) -> CachePlan:
        with self.sessions() as session:
            return evict(session, self.settings, trigger, actor)

    def forever(self, stop: threading.Event, leader: Leader) -> None:
        checked = time.monotonic()
        while not stop.wait(POLL_SECONDS):
            due = time.monotonic() - checked >= CHECK_SECONDS
            if not (due or self.woken.is_set()):
                continue
            trigger = "install" if self.woken.is_set() else "hourly"
            self.woken.clear()
            checked = time.monotonic()
            try:
                if leader.held():
                    self.run(trigger)
            except Exception:
                log.exception("base model cache check failed")
