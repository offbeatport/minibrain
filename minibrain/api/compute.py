from datetime import datetime
from typing import Annotated

from fastapi import APIRouter
from pydantic import BaseModel, Field, StringConstraints

from minibrain.api.deps import LocalNodeDep, SessionDep
from minibrain.api.policies import LOCAL_USER
from minibrain.registry.compute import Pool, pools
from minibrain.registry.models import AuditEvent
from minibrain.registry.prices import KEY, DevicePrices, load_prices, save_prices

router = APIRouter(prefix="/api/compute", tags=["compute"])

MAX_HOURLY_PRICE = 1_000_000
PoolName = Annotated[str, StringConstraints(min_length=1, max_length=200)]
HourlyPrice = Annotated[float, Field(ge=0, le=MAX_HOURLY_PRICE)]


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
    versions: dict[str, str] = {}


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


class PoolPrice(BaseModel):
    pool: str
    label: str
    accelerators: list[str]
    hourly_price: float | None


class DevicePricesInfo(BaseModel):
    currency: str
    pools: list[PoolPrice]


class DevicePricesUpdate(BaseModel):
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    hourly: dict[PoolName, HourlyPrice] | None = None


def accelerators(pool: Pool) -> list[str]:
    names = [node.report.accelerator_name for node in pool.nodes if node.report.accelerator_name]
    return list(dict.fromkeys(names))


def prices_info(found: list[Pool], prices: DevicePrices) -> DevicePricesInfo:
    listed = [
        PoolPrice(
            pool=pool.name, label=pool.label, accelerators=accelerators(pool), hourly_price=prices.hourly_for(pool.name)
        )
        for pool in found
    ]
    known = {pool.name for pool in found}
    gone = [
        PoolPrice(pool=name, label=name, accelerators=[], hourly_price=price)
        for name, price in sorted(prices.hourly.items())
        if name not in known
    ]
    return DevicePricesInfo(currency=prices.currency, pools=listed + gone)


@router.get("/prices")
def read_prices(session: SessionDep, node: LocalNodeDep) -> DevicePricesInfo:
    return prices_info(pools(session, node), load_prices(session))


@router.put("/prices")
def update_prices(body: DevicePricesUpdate, session: SessionDep, node: LocalNodeDep) -> DevicePricesInfo:
    before = load_prices(session)
    saved = save_prices(session, body.currency, body.hourly)
    if saved != before:
        detail = {"from": before.as_dict(), "to": saved.as_dict()}
        session.add(AuditEvent(actor=LOCAL_USER, action="settings.prices", target=KEY, detail=detail))
    session.commit()
    return prices_info(pools(session, node), saved)
