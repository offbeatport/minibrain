import hashlib
import json
import logging
import threading
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime
from pathlib import Path
from typing import Any, Protocol

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from minibrain.artifacts import ArtifactStore
from minibrain.base_models import BaseModelSpec
from minibrain.data.snapshot import prompt_context
from minibrain.models.registry import resolve_spec
from minibrain.policy import load as load_policy
from minibrain.registry.files import ref, snapshot_dir
from minibrain.registry.models import ApiKey, Minibrain, Model, ModelStatus, VersionKind, VersionStatus
from minibrain.registry.service import NotFoundError, adapter_name
from minibrain.settings import Settings

log = logging.getLogger("minibrain.gateway")


@dataclass(frozen=True)
class Route:
    name: str
    owner: str
    minibrain_id: int | None
    model_id: str | None
    slug: str
    version: int | None
    kind: str
    base_model: str
    labels: list[str]
    shots: list[list[str]]
    adapter: dict[str, Any] | None


@dataclass(frozen=True)
class Grant:
    key_id: int
    minibrain_id: int | None
    model_id: str | None
    expires_at: str | None = None

    def expired(self, moment: datetime) -> bool:
        return self.expires_at is not None and datetime.fromisoformat(self.expires_at) <= moment

    @property
    def owner(self) -> str:
        return owner_of(self.minibrain_id, self.model_id)


def owner_of(minibrain_id: int | None, model_id: str | None) -> str:
    return f"minibrain:{minibrain_id}" if minibrain_id is not None else f"model:{model_id}"


@dataclass(frozen=True)
class GatewayConfig:
    version: str
    routes: dict[str, Route] = field(default_factory=dict)
    keys: dict[str, Grant] = field(default_factory=dict)
    models: dict[str, list[str]] = field(default_factory=dict)
    engines: dict[str, str] = field(default_factory=dict)
    bases: dict[str, dict[str, Any]] = field(default_factory=dict)
    request_logs: bool = True

    def to_json(self) -> str:
        return json.dumps(asdict(self), sort_keys=True)

    @staticmethod
    def from_json(raw: str) -> "GatewayConfig":
        data = json.loads(raw)
        return GatewayConfig(
            version=data["version"],
            routes={name: Route(**route) for name, route in data["routes"].items()},
            keys={digest: Grant(**grant) for digest, grant in data["keys"].items()},
            models=dict(data["models"]),
            engines=dict(data.get("engines", {})),
            bases=dict(data.get("bases", {})),
            request_logs=bool(data.get("request_logs", True)),
        )


EMPTY = GatewayConfig(version="empty")


def routes_for(session: Session, store: ArtifactStore, minibrain: Minibrain) -> list[Route]:
    ready = sorted((v for v in minibrain.versions if v.status == VersionStatus.READY), key=lambda v: v.number)
    routes: list[Route] = []
    for version in ready:
        labels, shots = prompt_context(str(snapshot_dir(session, store, version.snapshot)))
        adapter = None
        if version.kind == VersionKind.LORA and version.adapter_artifact_id is not None:
            adapter = {
                "name": adapter_name(minibrain.slug, version.number),
                "artifact": ref(session, version.adapter_artifact_id),
            }
        route = Route(
            name=f"{minibrain.slug}@{version.number}",
            owner=owner_of(minibrain.id, None),
            minibrain_id=minibrain.id,
            model_id=None,
            slug=minibrain.slug,
            version=version.number,
            kind=version.kind,
            base_model=minibrain.base_model,
            labels=list(labels),
            shots=[[shot.input, shot.label] for shot in shots],
            adapter=adapter,
        )
        routes.append(route)
        if version.number == minibrain.current_version:
            routes.append(replace(route, name=minibrain.slug))
    return routes


def base_route(model: Model) -> Route:
    return Route(
        name=model.id,
        owner=owner_of(None, model.id),
        minibrain_id=None,
        model_id=model.id,
        slug=model.id,
        version=None,
        kind="base",
        base_model=model.id,
        labels=[],
        shots=[],
        adapter=None,
    )


def build_config(session: Session, store: ArtifactStore, settings: Settings, engines: dict[str, str]) -> GatewayConfig:
    routes: dict[str, Route] = {}
    for minibrain in session.scalars(select(Minibrain).order_by(Minibrain.id)):
        routes |= {route.name: route for route in routes_for(session, store, minibrain)}
    deployed = select(Model).where(Model.deployed.is_(True), Model.status == ModelStatus.AVAILABLE)
    routes |= {model.id: base_route(model) for model in session.scalars(deployed)}
    bases: dict[str, dict[str, Any]] = {}
    for key in sorted({route.base_model for route in routes.values()}):
        try:
            bases[key] = resolve_spec(session, settings, key).as_dict()
        except NotFoundError:
            routes = {name: route for name, route in routes.items() if route.base_model != key}
    models: dict[str, list[str]] = {}
    for route in routes.values():
        models.setdefault(route.owner, []).append(route.name)
    models = {owner: sorted(names, key=lambda name: ("@" in name, name)) for owner, names in models.items()}
    keys = {
        key.digest: Grant(
            key_id=key.id,
            minibrain_id=key.minibrain_id,
            model_id=key.model_id,
            expires_at=key.expires_at.isoformat() if key.expires_at else None,
        )
        for key in session.scalars(select(ApiKey))
    }
    logging = bool(load_policy(session)["request_logs"])
    config = GatewayConfig(
        version="", routes=routes, keys=keys, models=models, engines=engines, bases=bases, request_logs=logging
    )
    return replace(config, version=hash_of(config.to_json()))


def hash_of(payload: str) -> str:
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


class ConfigSource(Protocol):
    def current(self) -> GatewayConfig: ...


class LocalConfig:
    def __init__(
        self,
        sessions: sessionmaker[Session],
        store: ArtifactStore,
        settings: Settings,
        engines: Callable[[dict[str, BaseModelSpec]], dict[str, str]],
        max_age: float = 1.0,
    ) -> None:
        self.sessions = sessions
        self.store = store
        self.settings = settings
        self.engines = engines
        self.max_age = max_age
        self.config = EMPTY
        self.built_at = 0.0
        self.lock = threading.Lock()
        self.changed = threading.Condition()

    def rebuild(self) -> GatewayConfig:
        with self.lock, self.sessions() as session:
            draft = build_config(session, self.store, self.settings, {})
            specs = {key: BaseModelSpec.from_dict(spec) for key, spec in draft.bases.items()}
            urls = self.engines(specs)
            config = build_config(session, self.store, self.settings, urls) if urls else draft
        self.built_at = time.monotonic()
        if config.version != self.config.version:
            with self.changed:
                self.config = config
                self.changed.notify_all()
        return self.config

    def current(self) -> GatewayConfig:
        if self.max_age <= 0 or time.monotonic() - self.built_at > self.max_age:
            return self.rebuild()
        return self.config

    def wait_for_change(self, version: str, timeout: float) -> GatewayConfig:
        deadline = time.monotonic() + timeout
        while self.current().version == version and time.monotonic() < deadline:
            with self.changed:
                self.changed.wait(timeout=min(0.5, max(deadline - time.monotonic(), 0.0)))
        return self.config

    def refresh_forever(self, stop: threading.Event) -> None:
        while not stop.wait(self.max_age):
            try:
                self.rebuild()
            except Exception:
                log.exception("gateway config rebuild failed")


class RemoteConfig:
    def __init__(self, fetch: Callable[[str, float], GatewayConfig | None], cache: Path) -> None:
        self.fetch = fetch
        self.cache = cache
        self.config = GatewayConfig.from_json(cache.read_text()) if cache.exists() else EMPTY

    def current(self) -> GatewayConfig:
        return self.config

    def poll(self, wait: float) -> bool:
        fresh = self.fetch(self.config.version, wait)
        if fresh is None or fresh.version == self.config.version:
            return False
        self.config = fresh
        self.cache.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.cache.with_suffix(".tmp")
        temporary.write_text(fresh.to_json())
        temporary.replace(self.cache)
        return True

    def follow(self, stop: threading.Event, wait: float = 25.0) -> None:
        delay = 1.0
        while not stop.is_set():
            try:
                self.poll(wait)
                delay = 1.0
            except Exception:
                log.warning("main unreachable; serving config %s from cache", self.config.version)
                stop.wait(delay)
                delay = min(delay * 2, 30.0)
