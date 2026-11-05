import hmac
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from minibrain.api.deps import SessionDep, SettingsDep, StoreDep
from minibrain.artifacts import is_artifact_id
from minibrain.data.feedback import Submission, record
from minibrain.gateway.config import LocalConfig
from minibrain.gateway.logs import LogEntry, database_sink
from minibrain.models.hardware import LOCAL_POOL
from minibrain.models.health import record_load_failure, record_loaded
from minibrain.models.registry import resolve_spec
from minibrain.models.usage import touch
from minibrain.registry.compute import EngineReport, GatewayReport, record_engine, record_gateway
from minibrain.registry.models import Model
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
    response_id: str | None = None
    input: str | None = None
    output: str | None = None
    finish_reason: str | None = None


class LogsBody(BaseModel):
    entries: list[LogBody]


class FeedbackBody(BaseModel):
    minibrain_id: int
    origin: str
    rating: str
    response_id: str | None = None
    version: int | None = None
    key_id: int | None = None
    input: str | None = None
    output: str | None = None
    correction: str | None = None
    comment: str | None = None


class FeedbackStored(BaseModel):
    id: int


class EngineBody(BaseModel):
    id: str
    host: str
    url: str
    base_model: str
    engine: str
    state: str
    pool: str = LOCAL_POOL
    hardware: dict[str, Any] = {}
    managed: bool = False
    error: str | None = None
    code: str | None = None


class GatewayBody(BaseModel):
    id: str
    host: str
    version: str
    routes: list[str] = []
    bases: list[str] = []


@router.post("/engines", status_code=204)
def register_engine(body: EngineBody, session: SessionDep) -> None:
    record_engine(session, EngineReport(**body.model_dump(exclude={"error", "code"})))
    if body.state == "failed":
        record_load_failure(session, body.base_model, body.code, body.error, body.host)
    elif body.state == "ready":
        record_loaded(session, body.base_model)
        touch(session, body.base_model)
    session.commit()


@router.post("/gateways", status_code=204)
def report_gateway(body: GatewayBody, session: SessionDep) -> None:
    record_gateway(session, GatewayReport(kind="standalone", **body.model_dump()))
    session.commit()


class BaseFile(BaseModel):
    path: str
    size: int
    sha256: str | None = None


class BaseWeights(BaseModel):
    spec: dict[str, Any]
    files: list[BaseFile]


def weights_folder(session: SessionDep, settings: SettingsDep, key: str) -> tuple[dict[str, Any], Path]:
    spec = resolve_spec(session, settings, key)
    try:
        return spec.as_dict(), local_dir(spec, offline=True).resolve()
    except Exception as error:
        raise HTTPException(status_code=404, detail=f"weights for {key} are not on main") from error


def listed_files(folder: Path) -> list[BaseFile]:
    return [
        BaseFile(path=path.relative_to(folder).as_posix(), size=path.stat().st_size)
        for path in sorted(folder.rglob("*"))
        if path.is_file() and not any(part.startswith(".") for part in path.relative_to(folder).parts)
    ]


def shareable(session: SessionDep, key: str, folder: Path) -> list[BaseFile]:
    model = session.get(Model, key)
    if model is None or not model.files:
        return listed_files(folder)
    return [
        BaseFile(path=str(entry["path"]), size=int(entry["size"]), sha256=entry.get("sha256")) for entry in model.files
    ]


@router.get("/bases/{key}")
def base_weights(key: str, session: SessionDep, settings: SettingsDep) -> BaseWeights:
    spec, folder = weights_folder(session, settings, key)
    return BaseWeights(spec=spec | {"path": None}, files=shareable(session, key, folder))


@router.get("/bases/{key}/files/{path:path}")
def base_file(key: str, path: str, session: SessionDep, settings: SettingsDep) -> FileResponse:
    _, folder = weights_folder(session, settings, key)
    candidate = (folder / path).resolve()
    known = {entry.path for entry in shareable(session, key, folder)}
    if path not in known or not candidate.is_file() or not candidate.is_relative_to(folder):
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


@router.post("/feedback", status_code=201)
def feedback(body: FeedbackBody, session: SessionDep) -> FeedbackStored:
    item = record(session, Submission(**body.model_dump()))
    session.commit()
    return FeedbackStored(id=item.id)


@router.get("/artifacts/{artifact_id}")
def artifact(artifact_id: str, store: StoreDep) -> StreamingResponse:
    if not is_artifact_id(artifact_id) or not store.has(artifact_id):
        raise HTTPException(status_code=404, detail=f"artifact {artifact_id} not found")
    return StreamingResponse(store.chunks(artifact_id), media_type="application/octet-stream")
