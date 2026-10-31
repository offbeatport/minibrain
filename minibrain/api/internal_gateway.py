import hmac
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from minibrain.api.deps import SessionDep, SettingsDep, StoreDep
from minibrain.artifacts import is_artifact_id
from minibrain.gateway.config import LocalConfig
from minibrain.gateway.logs import LogEntry, database_sink
from minibrain.models.hardware import LOCAL_POOL
from minibrain.models.registry import resolve_spec
from minibrain.registry.compute import EngineReport, record_engine
from minibrain.serve.weights import local_dir

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


class BaseFile(BaseModel):
    path: str
    size: int


class BaseWeights(BaseModel):
    spec: dict[str, Any]
    files: list[BaseFile]


def weights_folder(session: SessionDep, settings: SettingsDep, key: str) -> tuple[dict[str, Any], Path]:
    spec = resolve_spec(session, settings, key)
    try:
        return spec.as_dict(), local_dir(spec, offline=True).resolve()
    except Exception as error:
        raise HTTPException(status_code=404, detail=f"weights for {key} are not on main") from error


def shareable(folder: Path) -> list[BaseFile]:
    return [
        BaseFile(path=path.relative_to(folder).as_posix(), size=path.stat().st_size)
        for path in sorted(folder.rglob("*"))
        if path.is_file() and not any(part.startswith(".") for part in path.relative_to(folder).parts)
    ]


@router.get("/bases/{key}")
def base_weights(key: str, session: SessionDep, settings: SettingsDep) -> BaseWeights:
    spec, folder = weights_folder(session, settings, key)
    return BaseWeights(spec=spec | {"path": None}, files=shareable(folder))


@router.get("/bases/{key}/files/{path:path}")
def base_file(key: str, path: str, session: SessionDep, settings: SettingsDep) -> FileResponse:
    _, folder = weights_folder(session, settings, key)
    candidate = (folder / path).resolve()
    if not candidate.is_file() or path not in {entry.path for entry in shareable(folder)}:
        raise HTTPException(status_code=404, detail=f"{path} is not part of {key}")
    return FileResponse(candidate)


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
