import hashlib
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.models.hardware import LOCAL_POOL, NodeReport, fit, needed_bytes, pool_fit
from minibrain.registry.compute import Pool, live_engines, node_id, pools
from minibrain.registry.models import BaseModel, CatalogVariant, Model, Node, Worker, now
from minibrain.tasks.service import serving_base

AUTO = "auto"
RUNS = ("fits", "limited")
HOST_FRESH = timedelta(seconds=30)
WEIGHT_SUFFIXES = (".safetensors", ".gguf")


class PlacementError(ValueError):
    pass


@dataclass(frozen=True)
class PoolOption:
    name: str
    label: str
    fit: dict[str, Any]
    free_bytes: int | None
    machines: int

    @property
    def runs(self) -> bool:
        return self.fit["level"] in RUNS


def weights_of(session: Session, key: str) -> tuple[int, dict[str, Any]]:
    base = session.get(BaseModel, key)
    if base is not None:
        weights = sum(int(entry["size"]) for entry in base.files if str(entry["path"]).endswith(WEIGHT_SUFFIXES))
        requires = dict(base.variant.requires) if base.variant is not None else {}
        return weights or base.size_bytes, requires
    query = select(CatalogVariant).where(CatalogVariant.catalog_id == key).order_by(CatalogVariant.position).limit(1)
    variant = session.scalar(query)
    return (variant.weights_bytes, dict(variant.requires)) if variant is not None else (0, {})


def deployments(session: Session) -> Iterable[tuple[str, str, str]]:
    for model in session.scalars(select(Model).where(Model.deployed.is_(True))):
        yield f"model:{model.id}", serving_base(model), model.pool or LOCAL_POOL
    for base in session.scalars(select(BaseModel).where(BaseModel.deployed.is_(True))):
        yield f"base:{base.id}", base.id, base.pool or LOCAL_POOL


def placed_bytes(session: Session, skip: str) -> dict[str, int]:
    found: dict[str, int] = {}
    for owner, key, pool in deployments(session):
        if owner != skip:
            found[pool] = found.get(pool, 0) + needed_bytes(weights_of(session, key)[0])
    return found


def option_of(pool: Pool, weights: int, requires: dict[str, Any], placed: int) -> PoolOption:
    machines = pool.machines()
    memory = [machine.memory_bytes for machine in machines if machine.memory_bytes is not None]
    free = max(memory) - placed if memory else None
    return PoolOption(pool.name, pool.label, pool_fit(weights, requires, machines), free, len(machines))


def pool_options(session: Session, local: NodeReport, key: str, owner: str) -> list[PoolOption]:
    weights, requires = weights_of(session, key)
    placed = placed_bytes(session, owner)
    return [option_of(pool, weights, requires, placed.get(pool.name, 0)) for pool in pools(session, local)]


def automatic(options: list[PoolOption]) -> PoolOption | None:
    local = next((option for option in options if option.name == LOCAL_POOL), None)
    if local is not None and local.fit["level"] == "fits":
        return local
    running = [option for option in options if option.runs]
    if not running:
        return None
    return max(running, key=lambda option: (option.fit["level"] == "fits", option.free_bytes or 0))


def choose_pool(options: list[PoolOption], asked: str | None, name: str) -> str:
    if asked is None or asked == AUTO:
        found = automatic(options)
        if found is None:
            raise PlacementError(f"{name} fits in no compute pool; add a machine with more memory or pick a pool")
        return found.name
    option = next((option for option in options if option.name == asked), None)
    if option is None:
        raise PlacementError(f"There is no compute pool named {asked}")
    if option.fit["level"] == "insufficient":
        raise PlacementError(f"{name} does not fit in pool {asked}: {option.fit['basis']}")
    return option.name


def resolve_pool(
    session: Session, local: NodeReport, key: str, owner: str, name: str, asked: str | None, current: str | None
) -> str:
    if asked is None and current is not None:
        return current
    return choose_pool(pool_options(session, local, key, owner), asked, name)


@dataclass(frozen=True)
class Asked:
    pool: str | None = None
    replicas: int | None = None


def engine_hosts(session: Session, pool: str) -> dict[str, str]:
    fresh = Worker.seen_at >= now() - HOST_FRESH
    hosts: dict[str, str] = {}
    for worker in session.scalars(select(Worker).where(Worker.pool == pool, fresh).order_by(Worker.id)):
        hosts.setdefault(worker.host, worker.id)
    return hosts


def rank(key: str, host: str) -> bytes:
    return hashlib.sha256(f"{key}|{host}".encode(), usedforsecurity=False).digest()


def fitting_hosts(session: Session, pool: str, hosts: list[str], key: str) -> list[str]:
    weights, requires = weights_of(session, key)
    found = []
    for host in hosts:
        node = session.get(Node, node_id(pool, host))
        report = NodeReport.from_dict(node.hardware | {"host": host}) if node is not None and node.hardware else None
        level = fit(weights, requires, report.hardware(pool)).get("level") if report is not None else "unknown"
        if level != "insufficient":
            found.append(host)
    return found


def assigned(session: Session, pool: str, key: str, replicas: int) -> list[str]:
    hosts = sorted(engine_hosts(session, pool))
    usable = fitting_hosts(session, pool, hosts, key)
    return sorted(usable, key=lambda host: rank(key, host))[:replicas]


def desired_engines(
    session: Session, placements: dict[str, dict[str, int]], pool: str, host: str, worker: str
) -> list[str]:
    if pool == LOCAL_POOL or engine_hosts(session, pool).get(host) != worker:
        return []
    wanted = [key for key, pools_of in placements.items() if pools_of.get(pool)]
    return sorted(key for key in wanted if host in assigned(session, pool, key, placements[key][pool]))


STATE_ORDER = ("ready", "fetching", "loading", "failed")
HEALTH_OF = {"ready": "running", "fetching": "fetching", "loading": "starting", "failed": "unhealthy"}


@dataclass(frozen=True)
class PoolEngines:
    states: dict[str, set[str]]
    hosts: int

    def health(self, key: str) -> str:
        found = self.states.get(key, set())
        best = next((state for state in STATE_ORDER if state in found), None)
        if best is not None:
            return HEALTH_OF[best]
        return "starting" if self.hosts else "waiting"


def pool_engines(session: Session, pool: str) -> PoolEngines:
    states: dict[str, set[str]] = {}
    for replica in live_engines(session):
        if replica.pool == pool:
            states.setdefault(replica.base_model, set()).add(replica.state)
    return PoolEngines(states, len(engine_hosts(session, pool)))
