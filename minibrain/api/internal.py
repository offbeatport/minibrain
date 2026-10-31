import hmac
import io
import time
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from minibrain.api.deps import QueueDep, SessionDep, StoreDep
from minibrain.artifacts import ArtifactError, Packing, is_artifact_id
from minibrain.jobs.queue import EventIn, WorkerInfo
from minibrain.registry.files import register
from minibrain.registry.models import Artifact

CLAIM_POLL_SECONDS = 0.5
MAX_CLAIM_WAIT_SECONDS = 30.0


def worker_token(request: Request, authorization: Annotated[str, Header()] = "") -> None:
    expected = request.app.state.settings.secret("worker_token")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not hmac.compare_digest(token.strip(), expected):
        raise HTTPException(status_code=401, detail="invalid worker token")


router = APIRouter(prefix="/internal/worker", tags=["worker"], dependencies=[Depends(worker_token)])


class WorkerBody(BaseModel):
    id: str
    host: str
    kinds: list[str]
    gpus: int = 1

    def info(self) -> WorkerInfo:
        return WorkerInfo(id=self.id, host=self.host, kinds=self.kinds, gpus=self.gpus)


class ClaimRequest(BaseModel):
    worker: WorkerBody
    wait: float = 0.0


class ClaimResponse(BaseModel):
    job_id: int
    kind: str
    attempt: int
    token: str
    params: dict[str, Any]
    lease_seconds: int


class TokenBody(BaseModel):
    token: str


class HeartbeatResponse(BaseModel):
    cancel: bool
    lease_expires_at: str


class EventBody(BaseModel):
    kind: str
    message: str = ""
    data: dict[str, Any] | None = None


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


class StoredArtifact(BaseModel):
    id: str
    size: int


def require_artifacts(session: SessionDep, ids: list[str | None]) -> None:
    missing = [artifact for artifact in ids if artifact is not None and session.get(Artifact, artifact) is None]
    if missing:
        raise HTTPException(status_code=422, detail=f"unknown artifacts: {', '.join(missing)}")


@router.post("/register", status_code=204)
def register_worker(body: WorkerBody, queue: QueueDep) -> None:
    queue.register(body.info())


@router.post("/claim", response_model=None)
def claim(body: ClaimRequest, queue: QueueDep) -> ClaimResponse | Response:
    deadline = time.monotonic() + max(0.0, min(body.wait, MAX_CLAIM_WAIT_SECONDS))
    worker = body.worker.info()
    queue.register(worker)
    while True:
        claimed = queue.claim(worker)
        if claimed is not None:
            return ClaimResponse(**claimed.__dict__)
        if time.monotonic() >= deadline:
            return Response(status_code=204)
        time.sleep(CLAIM_POLL_SECONDS)


@router.post("/jobs/{job_id}/heartbeat")
def heartbeat(job_id: int, body: TokenBody, queue: QueueDep) -> HeartbeatResponse:
    beat = queue.heartbeat(job_id, body.token)
    return HeartbeatResponse(cancel=beat.cancel, lease_expires_at=beat.lease_expires_at.isoformat())


@router.post("/jobs/{job_id}/events", status_code=204)
def events(job_id: int, body: EventsBody, queue: QueueDep) -> None:
    queue.record(job_id, body.token, [EventIn(event.kind, event.message, event.data) for event in body.events])


@router.post("/jobs/{job_id}/complete", status_code=204)
def complete(job_id: int, body: CompleteBody, queue: QueueDep, session: SessionDep) -> None:
    require_artifacts(session, [*body.outputs.values(), body.log])
    queue.complete(job_id, body.token, body.result, body.outputs, body.log)


@router.post("/jobs/{job_id}/fail", status_code=204)
def fail(job_id: int, body: FailBody, queue: QueueDep, session: SessionDep) -> None:
    require_artifacts(session, [body.log])
    queue.fail(job_id, body.token, body.error, body.retryable, body.log)


@router.put("/artifacts/{artifact_id}")
async def upload_artifact(
    artifact_id: str,
    request: Request,
    session: SessionDep,
    store: StoreDep,
    x_artifact_kind: Annotated[str, Header()],
    x_artifact_packing: Annotated[str, Header()],
    x_artifact_name: Annotated[str, Header()],
) -> StoredArtifact:
    if x_artifact_packing not in (Packing.FILE, Packing.TAR) or not is_artifact_id(artifact_id):
        raise HTTPException(status_code=422, detail="bad artifact id or packing")
    data = b"".join([chunk async for chunk in request.stream()])
    try:
        stored = store.put_stream(io.BytesIO(data), expected=artifact_id)
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
