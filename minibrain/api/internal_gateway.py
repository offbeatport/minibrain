import hmac
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from minibrain.api.deps import SessionDep, StoreDep
from minibrain.artifacts import is_artifact_id
from minibrain.gateway.config import LocalConfig
from minibrain.gateway.logs import LogEntry, database_sink
from minibrain.models.hardware import LOCAL_POOL
from minibrain.registry.compute import EngineReport, record_engine

MAX_WAIT_SECONDS = 30.0


def gateway_token(request: Request, authorization: Annotated[str, Header()] = "") -> None:
    expected = request.app.state.settings.secret("gateway_token")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not hmac.compare_digest(token.strip(), expected):
        raise HTTPException(status_code=401, detail="invalid gateway token")


router = APIRouter(prefix="/internal/gateway", tags=["gateway"], dependencies=[Depends(gateway_token)])


class LogBody(BaseModel):
    at: datetime
    key_id: int | None
    minibrain_id: int | None
    model: str
    version: int | None
    status: int
    latency_ms: float
    prompt_tokens: int = 0
    completion_tokens: int = 0


class LogsBody(BaseModel):
    entries: list[LogBody]


class EngineBody(BaseModel):
    id: str
    host: str
    url: str
    base_model: str
    engine: str
    state: str
    pool: str = LOCAL_POOL
    hardware: dict[str, Any] = {}


@router.post("/engines", status_code=204)
def register_engine(body: EngineBody, session: SessionDep) -> None:
    record_engine(session, EngineReport(**body.model_dump()))
    session.commit()


@router.get("/config")
def config(request: Request, version: str = "", wait: float = 0.0) -> Response:
    source: LocalConfig = request.app.state.gateway_config
    current = source.wait_for_change(version, max(0.0, min(wait, MAX_WAIT_SECONDS))) if version else source.current()
    if current.version == version:
        return Response(status_code=304, headers={"ETag": current.version})
    return Response(content=current.to_json(), media_type="application/json", headers={"ETag": current.version})


@router.post("/logs", status_code=204)
def logs(body: LogsBody, request: Request) -> None:
    database_sink(request.app.state.sessions)([LogEntry(**entry.model_dump()) for entry in body.entries])


@router.get("/artifacts/{artifact_id}")
def artifact(artifact_id: str, store: StoreDep) -> StreamingResponse:
    if not is_artifact_id(artifact_id) or not store.has(artifact_id):
        raise HTTPException(status_code=404, detail=f"artifact {artifact_id} not found")
    return StreamingResponse(store.chunks(artifact_id), media_type="application/octet-stream")
