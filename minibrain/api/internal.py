import hmac
import time
from datetime import datetime
from typing import Annotated, Any, Literal

import pydantic
from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import Field

from minibrain.api.bases import BaseWeights, LiveBases, live
from minibrain.api.bases import base_file as file_of
from minibrain.api.bases import base_weights as weights_of
from minibrain.api.deps import QueueDep, SessionDep, SettingsDep, StoreDep
from minibrain.api.uploads import store_body
from minibrain.artifacts import ArtifactError, Packing, is_artifact_id
from minibrain.connections.s3 import job_env
from minibrain.connections.spec import ConnectionProblem
from minibrain.connections.store import get_connection, resolve
from minibrain.jobs.queue import EventIn, WorkerInfo
from minibrain.lifecycle import STOPPING
from minibrain.models.bucket import WEIGHTS, stored_files, writes_bucket
from minibrain.models.hardware import LOCAL_POOL
from minibrain.models.placement import desired_engines
from minibrain.models.registry import check_job
from minibrain.policy import PolicyError
from minibrain.registry.compute import record_node
from minibrain.registry.files import register
from minibrain.registry.models import Artifact, BaseModel, Job, JobKind
from minibrain.registry.service import ConflictError, NotFoundError
from minibrain.settings import Settings

CLAIM_POLL_SECONDS = 0.5
MAX_CLAIM_WAIT_SECONDS = 30.0


def worker_token(request: Request, authorization: Annotated[str, Header()] = "") -> None:
    expected = request.app.state.settings.secret("worker_token")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not hmac.compare_digest(token.strip(), expected):
        raise HTTPException(status_code=401, detail="invalid worker token")


router = APIRouter(prefix="/internal/worker", include_in_schema=False, dependencies=[Depends(worker_token)])


class WorkerBody(pydantic.BaseModel):
    id: str
    host: str
    kinds: list[str]
    gpus: int = 1
    pool: str = LOCAL_POOL
    hardware: dict[str, Any] = Field(default_factory=dict)

    def info(self) -> WorkerInfo:
        return WorkerInfo(id=self.id, host=self.host, kinds=self.kinds, gpus=self.gpus, pool=self.pool)


class ClaimRequest(pydantic.BaseModel):
    worker: WorkerBody
    wait: float = 0.0


class ClaimResponse(pydantic.BaseModel):
    job_id: int
    kind: str
    attempt: int
    token: str
    params: dict[str, Any]
    lease_seconds: int
    env: dict[str, str] = Field(default_factory=dict)


class HostedEngine(pydantic.BaseModel):
    model: str


class EnginesRequest(pydantic.BaseModel):
    worker: WorkerBody


class EnginesResponse(pydantic.BaseModel):
    engines: list[HostedEngine]
    gateway_token: str


class TokenBody(pydantic.BaseModel):
    token: str


class HeartbeatResponse(pydantic.BaseModel):
    cancel: bool
    lease_expires_at: str


class EventBody(pydantic.BaseModel):
    kind: Literal["event", "log"]
    message: str = ""
    data: dict[str, Any] | None = None
    level: Literal["debug", "info", "warning", "error"] = "info"
    name: str | None = None
    at: datetime | None = None


class EventsBody(TokenBody):
    events: list[EventBody] = Field(default_factory=list)


class CompleteBody(TokenBody):
    result: dict[str, Any] = Field(default_factory=dict)
    outputs: dict[str, str] = Field(default_factory=dict)
    log: str | None = None


class FailBody(TokenBody):
    error: str
    retryable: bool = True
    log: str | None = None
    code: str | None = None


class StoredArtifact(pydantic.BaseModel):
    id: str
    size: int


def require_artifacts(session: SessionDep, ids: list[str | None]) -> None:
    missing = [artifact for artifact in ids if artifact is not None and session.get(Artifact, artifact) is None]
    if missing:
        raise HTTPException(status_code=422, detail=f"unknown artifacts: {', '.join(missing)}")


def policy_refusal(session: SessionDep, job_id: int) -> str | None:
    session.expire_all()
    job = session.get(Job, job_id)
    if job is None:
        return None
    try:
        check_job(session, job)
    except (PolicyError, ConflictError) as error:
        return str(error)
    return None


def job_secrets(session: SessionDep, settings: Settings, job_id: int) -> dict[str, str]:
    job = session.get(Job, job_id)
    connection_id = job.params.get("connection_id") if job is not None else None
    if job is None or job.kind not in (JobKind.IMPORT, JobKind.REPAIR) or connection_id is None:
        return {}
    return job_env(resolve(session, settings, get_connection(session, int(connection_id))))


def report_worker(session: SessionDep, body: WorkerBody) -> None:
    record_node(session, body.pool, body.host, "worker", body.hardware)
    session.commit()


@router.post("/register", status_code=204)
def register_worker(body: WorkerBody, queue: QueueDep, session: SessionDep) -> None:
    queue.register(body.info())
    report_worker(session, body)


@router.post("/claim", response_model=None)
def claim(body: ClaimRequest, queue: QueueDep, session: SessionDep, settings: SettingsDep) -> ClaimResponse | Response:
    deadline = time.monotonic() + max(0.0, min(body.wait, MAX_CLAIM_WAIT_SECONDS))
    worker = body.worker.info()
    queue.register(worker)
    report_worker(session, body.worker)
    while True:
        claimed = queue.claim(worker)
        if claimed is not None:
            refusal = policy_refusal(session, claimed.job_id)
            if refusal is None:
                try:
                    env = job_secrets(session, settings, claimed.job_id)
                except (ConnectionProblem, PolicyError, NotFoundError) as error:
                    refusal = str(error)
                else:
                    return ClaimResponse(**claimed.__dict__, env=env)
            queue.fail(claimed.job_id, claimed.token, refusal, False, None)
            continue
        if STOPPING.is_set() or time.monotonic() >= deadline:
            return Response(status_code=204)
        STOPPING.wait(CLAIM_POLL_SECONDS)


@router.post("/engines")
def hosted_engines(
    body: EnginesRequest, request: Request, queue: QueueDep, session: SessionDep, settings: SettingsDep
) -> EnginesResponse:
    worker = body.worker
    queue.register(worker.info())
    report_worker(session, worker)
    config = request.app.state.gateway_config.current()
    placements = {key: found for key, found in config.placements.items() if key not in config.problems}
    wanted = desired_engines(session, placements, worker.pool, worker.host, worker.id)
    return EnginesResponse(
        engines=[HostedEngine(model=key) for key in wanted], gateway_token=settings.secret("gateway_token")
    )


@router.post("/jobs/{job_id}/heartbeat")
def heartbeat(job_id: int, body: TokenBody, queue: QueueDep) -> HeartbeatResponse:
    beat = queue.heartbeat(job_id, body.token)
    return HeartbeatResponse(cancel=beat.cancel, lease_expires_at=beat.lease_expires_at.isoformat())


@router.post("/jobs/{job_id}/events", status_code=204)
def events(job_id: int, body: EventsBody, queue: QueueDep) -> None:
    queue.record(
        job_id,
        body.token,
        [EventIn(e.kind, e.message, e.data, e.level, e.name, e.at) for e in body.events],
    )


@router.post("/jobs/{job_id}/complete", status_code=204)
def complete(job_id: int, body: CompleteBody, queue: QueueDep, session: SessionDep) -> None:
    require_artifacts(session, [*body.outputs.values(), body.log])
    queue.complete(job_id, body.token, body.result, body.outputs, body.log)


@router.post("/jobs/{job_id}/fail", status_code=204)
def fail(job_id: int, body: FailBody, queue: QueueDep, session: SessionDep) -> None:
    require_artifacts(session, [body.log])
    queue.fail(job_id, body.token, body.error, body.retryable, body.log, body.code)


@router.put("/artifacts/{artifact_id}")
async def upload_artifact(
    artifact_id: str,
    request: Request,
    session: SessionDep,
    store: StoreDep,
    x_artifact_kind: Annotated[str, Header()],
    x_artifact_packing: Annotated[str, Header()],
    x_artifact_name: Annotated[str, Header()],
    x_artifact_replace: Annotated[str, Header()] = "",
) -> StoredArtifact:
    if x_artifact_packing not in (Packing.FILE, Packing.TAR) or not is_artifact_id(artifact_id):
        raise HTTPException(status_code=422, detail="bad artifact id or packing")
    if x_artifact_kind == WEIGHTS and not writes_bucket(store):
        raise HTTPException(status_code=422, detail="Storage is no longer a bucket; start the transfer again")
    try:
        stored = await store_body(store, request, artifact_id, replace=x_artifact_replace == "1")
    except ArtifactError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    register(session, stored.id, x_artifact_kind, x_artifact_packing, x_artifact_name, stored.size)
    session.commit()
    return StoredArtifact(id=stored.id, size=stored.size)


@router.get("/artifacts/{artifact_id}")
def download_artifact(artifact_id: str, store: StoreDep) -> StreamingResponse:
    if not is_artifact_id(artifact_id) or not store.has(artifact_id):
        raise HTTPException(status_code=404, detail=f"artifact {artifact_id} not found")
    return StreamingResponse(store.chunks(artifact_id), media_type="application/octet-stream")


class StoredFiles(pydantic.BaseModel):
    files: list[dict[str, Any]]


@router.get("/bases/{base_model_id}/stored")
def stored(base_model_id: str, session: SessionDep, store: StoreDep) -> StoredFiles:
    model = session.get(BaseModel, base_model_id)
    if model is None:
        raise HTTPException(status_code=404, detail=f"model {base_model_id} not found")
    return StoredFiles(files=stored_files(session, store, model))


@router.get("/bases")
def bases(session: SessionDep) -> LiveBases:
    return live(session)


@router.get("/bases/{key}")
def base_weights(
    key: str, session: SessionDep, settings: SettingsDep, store: StoreDep, response: Response
) -> BaseWeights:
    return weights_of(session, settings, store, key, response)


@router.get("/bases/{key}/files/{path:path}")
def base_file(key: str, path: str, session: SessionDep, settings: SettingsDep) -> FileResponse:
    return file_of(session, settings, key, path)
