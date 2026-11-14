from typing import Any

from sqlalchemy.orm import Session

from minibrain.auth.identity import current_actor
from minibrain.models.hardware import LOCAL_POOL, NodeReport
from minibrain.models.placement import Asked, resolve_pool
from minibrain.registry.models import AuditEvent, BaseModel, Model
from minibrain.tasks.service import serving_base


def changes(before: str | None, pool: str, replicas: int, had: int) -> dict[str, Any] | None:
    if before == pool and had == replicas:
        return None
    facts: dict[str, Any] = {"pool": pool, "replicas": replicas}
    return facts | ({"from_pool": before} if before is not None and before != pool else {})


def place_custom(session: Session, model: Model, local: NodeReport, asked: Asked) -> dict[str, Any] | None:
    before = (model.pool or LOCAL_POOL) if model.deployed else None
    model.deployed = True
    key = serving_base(model)
    pool = resolve_pool(session, local, key, f"model:{model.id}", model.name, asked.pool, before)
    replicas = asked.replicas or (model.replicas if before is not None else 1)
    facts = changes(before, pool, replicas, model.replicas)
    model.pool, model.replicas = pool, replicas
    return facts


def audit_deploy(session: Session, model: Model, facts: dict[str, Any]) -> None:
    detail = {"name": model.name, "version": model.current_version} | facts
    session.add(AuditEvent(actor=current_actor(), action="model.deploy", target=model.slug, detail=detail))


def place_base(session: Session, base: BaseModel, local: NodeReport, asked: Asked) -> None:
    before = (base.pool or LOCAL_POOL) if base.deployed else None
    pool = resolve_pool(session, local, base.id, f"base:{base.id}", base.name, asked.pool, before)
    replicas = asked.replicas or (base.replicas if before is not None else 1)
    facts = changes(before, pool, replicas, base.replicas)
    if facts is not None:
        detail = {"name": base.name} | facts
        session.add(AuditEvent(actor=current_actor(), action="model.deploy", target=base.id, detail=detail))
    base.pool, base.replicas = pool, replicas
    base.deployed = True
