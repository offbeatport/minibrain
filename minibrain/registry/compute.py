from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from minibrain.models.hardware import LOCAL_LABEL, LOCAL_POOL, Hardware, NodeReport
from minibrain.registry.models import EngineReplica, Node, now

NODE_FRESH = timedelta(minutes=2)
ENGINE_FRESH = timedelta(seconds=30)
FORGET_ENGINES = timedelta(hours=1)
FORGET_NODES = timedelta(days=7)


@dataclass(frozen=True)
class EngineReport:
    id: str
    pool: str
    host: str
    url: str
    base_model: str
    engine: str
    state: str
    hardware: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class PoolNode:
    id: str
    host: str
    roles: list[str]
    report: NodeReport
    seen_at: datetime | None
    online: bool


@dataclass(frozen=True)
class Pool:
    name: str
    label: str
    nodes: list[PoolNode]
    engines: list[EngineReplica]

    def machines(self) -> list[Hardware]:
        return [node.report.hardware() for node in self.nodes if node.online]


def node_id(pool: str, host: str) -> str:
    return f"{pool}/{host}"


def pool_label(name: str) -> str:
    return LOCAL_LABEL if name == LOCAL_POOL else name


def record_node(session: Session, pool: str, host: str, role: str, hardware: dict[str, Any]) -> Node:
    key = node_id(pool, host)
    node = session.get(Node, key) or Node(id=key, pool=pool, host=host, roles=[], hardware={})
    if hardware:
        node.hardware = hardware
    if role not in node.roles:
        node.roles = [*node.roles, role]
    node.seen_at = now()
    session.add(node)
    return node


def record_engine(session: Session, report: EngineReport) -> EngineReplica:
    node = record_node(session, report.pool, report.host, "engine", report.hardware)
    replica = session.get(EngineReplica, report.id) or EngineReplica(id=report.id)
    replica.node_id = node.id
    replica.pool = report.pool
    replica.base_model = report.base_model
    replica.engine = report.engine
    replica.url = report.url
    replica.state = report.state
    replica.seen_at = now()
    session.add(replica)
    return replica


def live_engines(session: Session) -> list[EngineReplica]:
    query = select(EngineReplica).where(EngineReplica.seen_at >= now() - ENGINE_FRESH).order_by(EngineReplica.id)
    return list(session.scalars(query))


def forget_stale(session: Session) -> None:
    moment = now()
    session.execute(delete(EngineReplica).where(EngineReplica.seen_at < moment - FORGET_ENGINES))
    session.execute(delete(Node).where(Node.seen_at < moment - FORGET_NODES))


def pools(session: Session, local: NodeReport) -> list[Pool]:
    moment = now()
    nodes: dict[str, list[PoolNode]] = {LOCAL_POOL: []}
    main_id = node_id(LOCAL_POOL, local.host)
    main_roles = ["main"]
    for node in session.scalars(select(Node).order_by(Node.pool, Node.host)):
        if node.id == main_id:
            main_roles += [role for role in node.roles if role not in main_roles]
            continue
        online = node.seen_at >= moment - NODE_FRESH
        report = NodeReport.from_dict(node.hardware | {"host": node.host})
        nodes.setdefault(node.pool, []).append(
            PoolNode(node.id, node.host, list(node.roles), report, node.seen_at, online)
        )
    nodes[LOCAL_POOL].insert(0, PoolNode(main_id, local.host, main_roles, local, None, True))
    engines: dict[str, list[EngineReplica]] = {}
    for replica in live_engines(session):
        engines.setdefault(replica.pool, []).append(replica)
    names = sorted(nodes.keys() | engines.keys(), key=lambda name: (name != LOCAL_POOL, name))
    return [Pool(name, pool_label(name), nodes.get(name, []), engines.get(name, [])) for name in names]


def find_pool(found: list[Pool], name: str | None) -> Pool:
    return next((pool for pool in found if pool.name == name), found[0])
