from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from minibrain.api.access import admin
from minibrain.api.deps import SessionDep, SettingsDep
from minibrain.auth.identity import current_actor
from minibrain.connections.vault import seal
from minibrain.policy import describe, update

router = APIRouter(prefix="/api", tags=["security"])


class PolicyChoice(BaseModel):
    value: str
    label: str
    use: str | None = None


class PolicyInfo(BaseModel):
    name: str
    label: str
    description: str
    kind: str
    choices: list[PolicyChoice]
    maximum: int | None = None
    value: Any
    locked: bool
    source: str


class PolicyUpdate(BaseModel):
    value: Any


@router.get("/policies", dependencies=[Depends(admin)])
def policies(session: SessionDep) -> list[PolicyInfo]:
    return [PolicyInfo(**item) for item in describe(session)]


@router.put("/policies/{name}", dependencies=[Depends(admin)])
def change_policy(name: str, body: PolicyUpdate, session: SessionDep, settings: SettingsDep) -> list[PolicyInfo]:
    update(session, name, body.value, current_actor(), lambda text, context: seal(settings, text, context))
    session.commit()
    return [PolicyInfo(**item) for item in describe(session)]
