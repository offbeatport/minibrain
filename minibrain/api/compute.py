from datetime import datetime

from fastapi import APIRouter
from pydantic import BaseModel

from minibrain.api.deps import LocalNodeDep, SessionDep
from minibrain.registry.compute import pools

router = APIRouter(prefix="/api/compute", tags=["compute"])


class GpuInfo(BaseModel):
    name: str
    memory_bytes: int


class NodeInfo(BaseModel):
    id: str
    host: str
    roles: list[str]
    online: bool
    seen_at: datetime | None
    system: str
    arch: str
    cpu_count: int
    ram_bytes: int | None
    accelerator: str
    accelerator_name: str
    usable_bytes: int | None
    gpus: list[GpuInfo]
    engines: list[str]


class ReplicaInfo(BaseModel):
    id: str
    base_model: str
    engine: str
    url: str
    state: str
    host: str
    seen_at: datetime


class PoolInfo(BaseModel):
    name: str
    label: str
    nodes: list[NodeInfo]
    engines: list[ReplicaInfo]


@router.get("/pools")
def list_pools(session: SessionDep, node: LocalNodeDep) -> list[PoolInfo]:
    found: list[PoolInfo] = []
    for pool in pools(session, node):
        nodes = [
            NodeInfo(
                id=item.id,
                host=item.host,
                roles=item.roles,
                online=item.online,
                seen_at=item.seen_at,
                **{key: value for key, value in item.report.as_dict().items() if key != "host"},
            )
            for item in pool.nodes
        ]
        engines = [
            ReplicaInfo(
                id=replica.id,
                base_model=replica.base_model,
                engine=replica.engine,
                url=replica.url,
                state=replica.state,
                host=replica.node_id.split("/", 1)[-1],
                seen_at=replica.seen_at,
            )
            for replica in pool.engines
        ]
        found.append(PoolInfo(name=pool.name, label=pool.label, nodes=nodes, engines=engines))
    return found
