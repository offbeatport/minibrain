from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import select

from minibrain.api.deps import SessionDep
from minibrain.policy import describe, update
from minibrain.registry.models import AuditEvent

router = APIRouter(prefix="/api", tags=["security"])
LOCAL_USER = "Local user"


class PolicyChoice(BaseModel):
    value: str
    label: str


class PolicyInfo(BaseModel):
    name: str
    label: str
    description: str
    kind: str
    choices: list[PolicyChoice]
    value: Any
    locked: bool
    source: str


class PolicyUpdate(BaseModel):
    value: Any


class AuditInfo(BaseModel):
    id: int
    at: str
    actor: str
    action: str
    target: str
    detail: dict[str, Any]


@router.get("/policies")
def policies(session: SessionDep) -> list[PolicyInfo]:
    return [PolicyInfo(**item) for item in describe(session)]


@router.put("/policies/{name}")
def change_policy(name: str, body: PolicyUpdate, session: SessionDep) -> list[PolicyInfo]:
    update(session, name, body.value, LOCAL_USER)
    session.commit()
    return [PolicyInfo(**item) for item in describe(session)]


@router.get("/audit")
def audit(session: SessionDep, limit: int = 50) -> list[AuditInfo]:
    events = session.scalars(select(AuditEvent).order_by(AuditEvent.id.desc()).limit(max(1, min(limit, 500))))
    return [
        AuditInfo(
            id=event.id,
            at=event.at.isoformat(),
            actor=event.actor,
            action=event.action,
            target=event.target,
            detail=dict(event.detail),
        )
        for event in events
    ]
