import logging
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.models.hardware import LOCAL_POOL
from minibrain.models.placement import assigned, engine_hosts
from minibrain.registry.compute import live_engines
from minibrain.registry.models import SYSTEM_ACTOR, AuditEvent, BaseModel, Model, now
from minibrain.tasks.service import serving_base

MOVE_WAIT = timedelta(minutes=5)
READY = "ready"
FAILED = "failed"

log = logging.getLogger("minibrain.handover")

Deployed = Model | BaseModel


def serving_pool(row: Deployed) -> str:
    return row.moving_from or row.pool or LOCAL_POOL


def moving_to(row: Deployed) -> str | None:
    return (row.pool or LOCAL_POOL) if row.moving_from else None


def stop_moving(row: Deployed) -> None:
    row.moving_from = None
    row.moving_since = None


def begin_move(row: Deployed, before: str | None, pool: str) -> None:
    row.move_failure = None
    if before is None:
        stop_moving(row)
        return
    if before == pool:
        return
    if row.moving_from == pool:
        stop_moving(row)
        return
    row.moving_from = row.moving_from or before
    row.moving_since = now()


@dataclass(frozen=True)
class Progress:
    done: bool = False
    failure: str | None = None


def needed(session: Session, key: str, pool: str, replicas: int) -> int:
    if pool == LOCAL_POOL:
        return 1
    return max(1, len(assigned(session, pool, key, replicas)))


def failure_of(session: Session, key: str, pool: str) -> str:
    base = session.get(BaseModel, key)
    message = (base.health_detail or {}).get("message") if base is not None and base.health else None
    return f"its engine in pool {pool} failed to start{f': {message}' if message else ''}"


def progress(session: Session, key: str, pool: str, replicas: int, since: datetime) -> Progress:
    found = [replica for replica in live_engines(session) if replica.base_model == key and replica.pool == pool]
    if sum(replica.state == READY for replica in found) >= needed(session, key, pool, replicas):
        return Progress(done=True)
    if any(replica.state == FAILED and replica.seen_at >= since for replica in found):
        return Progress(failure=failure_of(session, key, pool))
    waited = now() - since
    if pool != LOCAL_POOL and not engine_hosts(session, pool) and waited > MOVE_WAIT:
        minutes = int(MOVE_WAIT.total_seconds() // 60)
        return Progress(failure=f"no machine in pool {pool} came online within {minutes} minutes")
    return Progress()


def key_of(row: Deployed) -> str:
    return serving_base(row) if isinstance(row, Model) else row.id


def target_of(row: Deployed) -> str:
    return row.slug if isinstance(row, Model) else row.id


def record(session: Session, row: Deployed, detail: dict[str, object]) -> None:
    facts = {"name": row.name, "from_pool": row.moving_from, "pool": row.pool or LOCAL_POOL} | detail
    session.add(AuditEvent(actor=SYSTEM_ACTOR, action="model.move", target=target_of(row), detail=facts))


def finish(session: Session, row: Deployed) -> None:
    log.info("%s now serves from pool %s; pool %s stops", row.name, row.pool, row.moving_from)
    record(session, row, {"outcome": "moved"})
    stop_moving(row)


def roll_back(session: Session, row: Deployed, failure: str) -> None:
    target, back = row.pool or LOCAL_POOL, row.moving_from or LOCAL_POOL
    log.warning("moving %s to pool %s failed: %s; it stays on %s", row.name, target, failure, back)
    record(session, row, {"outcome": "rolled_back", "error": failure})
    row.move_failure = f"Moving to {target} failed: {failure}. It stays on {back}."
    row.pool = back
    stop_moving(row)


def advance(session: Session, row: Deployed) -> bool:
    if not row.deployed or row.moving_since is None:
        stop_moving(row)
        return True
    found = progress(session, key_of(row), row.pool or LOCAL_POOL, row.replicas, row.moving_since)
    if found.done:
        finish(session, row)
    elif found.failure is not None:
        roll_back(session, row, found.failure)
    return found.done or found.failure is not None


def moving_rows(session: Session) -> list[Deployed]:
    models: list[Deployed] = list(session.scalars(select(Model).where(Model.moving_from.is_not(None))))
    bases: list[Deployed] = list(session.scalars(select(BaseModel).where(BaseModel.moving_from.is_not(None))))
    return models + bases


def advance_moves(session: Session) -> bool:
    changed = [row for row in moving_rows(session) if advance(session, row)]
    if changed:
        session.commit()
    return bool(changed)
