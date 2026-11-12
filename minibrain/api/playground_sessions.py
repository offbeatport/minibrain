import json
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.api.access import viewer
from minibrain.api.deps import SessionDep, SettingsDep
from minibrain.api.playground import owner_id
from minibrain.encryption.keys import Keys, keys_for
from minibrain.gateway.config import GatewayConfig
from minibrain.policy import PolicyError
from minibrain.policy import load as load_policy
from minibrain.registry import playground_sessions as chats
from minibrain.registry.models import Model, PlaygroundSession, now

router = APIRouter(prefix="/api/playground")

LISTED = 500
MAX_TURNS = 1000
MAX_BYTES = 4_000_000
TOO_LONG = "This chat is too long to save; start a new one."
Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
ABOUT = (
    "Playground chats are saved for the signed-in person only, encrypted at rest, when the model keeps request "
    "inputs and answers. They are deleted with the request logs (Log retention)."
)


class ChatState(BaseModel):
    turns: list[dict[str, Any]] = Field(default_factory=list, max_length=MAX_TURNS)
    settings: dict[str, Any] = Field(default_factory=dict)
    preset: int | None = None


class ChatBody(BaseModel):
    model: str = Field(min_length=1, max_length=200)
    version: int | None = None
    title: Title | None = None
    state: ChatState


class ChatUpdate(BaseModel):
    model: str | None = Field(default=None, min_length=1, max_length=200)
    version: int | None = None
    title: Title | None = None
    state: ChatState | None = None


class ChatSummary(BaseModel):
    id: int
    title: str
    model: str
    version: int | None
    created_at: datetime
    updated_at: datetime


class ChatDetail(ChatSummary):
    state: ChatState


def summary_of(keys: Keys, row: PlaygroundSession) -> ChatSummary:
    return ChatSummary(
        id=row.id,
        title=chats.title_of(keys, row),
        model=row.model,
        version=row.version,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def detail_of(keys: Keys, row: PlaygroundSession) -> ChatDetail:
    state = ChatState.model_validate(chats.state_of(keys, row))
    return ChatDetail.model_validate(summary_of(keys, row).model_dump() | {"state": state})


def custom_model(session: Session, config: GatewayConfig, name: str) -> Model | None:
    route = config.routes.get(name)
    if route is None or route.model_id is None:
        return None
    return session.get(Model, route.model_id)


def require_kept(request: Request, session: Session, name: str) -> None:
    model = custom_model(session, request.app.state.gateway_config.current(), name)
    reason = chats.not_kept(load_policy(session), model)
    if reason is not None:
        raise PolicyError(reason)


def checked_state(state: ChatState) -> dict[str, Any]:
    found = state.model_dump()
    if len(json.dumps(found, ensure_ascii=False)) > MAX_BYTES:
        raise HTTPException(status_code=413, detail=TOO_LONG)
    return found


def own_chat(session: Session, chat_id: int) -> PlaygroundSession:
    row = session.get(PlaygroundSession, chat_id)
    if row is None or row.user_id != owner_id():
        raise HTTPException(status_code=404, detail="no such chat")
    return row


@router.get("/sessions", dependencies=[Depends(viewer)], summary="List my Playground chats", description=ABOUT)
def list_chats(session: SessionDep, settings: SettingsDep) -> list[ChatSummary]:
    keys = keys_for(settings)
    query = (
        select(PlaygroundSession)
        .where(PlaygroundSession.user_id == owner_id())
        .order_by(PlaygroundSession.updated_at.desc(), PlaygroundSession.id.desc())
        .limit(LISTED)
    )
    return [summary_of(keys, row) for row in session.scalars(query)]


@router.post("/sessions", status_code=201, dependencies=[Depends(viewer)], summary="Save a Playground chat")
def create_chat(body: ChatBody, request: Request, session: SessionDep, settings: SettingsDep) -> ChatDetail:
    require_kept(request, session, body.model)
    state = checked_state(body.state)
    keys = keys_for(settings)
    row = PlaygroundSession(user_id=owner_id(), model=body.model, version=body.version)
    session.add(row)
    session.flush()
    chats.seal_title(keys, row, body.title or chats.title_from(body.state.turns))
    chats.seal_state(keys, row, state)
    session.commit()
    return detail_of(keys, row)


@router.get("/sessions/{chat_id}", dependencies=[Depends(viewer)], summary="Open a Playground chat")
def read_chat(chat_id: int, session: SessionDep, settings: SettingsDep) -> ChatDetail:
    return detail_of(keys_for(settings), own_chat(session, chat_id))


@router.put("/sessions/{chat_id}", dependencies=[Depends(viewer)], summary="Update or rename a Playground chat")
def update_chat(
    chat_id: int, body: ChatUpdate, request: Request, session: SessionDep, settings: SettingsDep
) -> ChatDetail:
    row = own_chat(session, chat_id)
    keys = keys_for(settings)
    if body.state is not None or body.model is not None:
        require_kept(request, session, body.model or row.model)
    if body.model is not None:
        row.model = body.model
        row.version = body.version
    if body.state is not None:
        chats.seal_state(keys, row, checked_state(body.state))
        row.updated_at = now()
    if body.title is not None:
        chats.seal_title(keys, row, body.title)
    session.commit()
    return detail_of(keys, row)


@router.delete(
    "/sessions/{chat_id}", status_code=204, dependencies=[Depends(viewer)], summary="Delete a Playground chat"
)
def delete_chat(chat_id: int, session: SessionDep) -> None:
    session.delete(own_chat(session, chat_id))
    session.commit()
