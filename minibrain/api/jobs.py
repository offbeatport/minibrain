import asyncio
import json
from collections.abc import AsyncIterator

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from starlette.concurrency import run_in_threadpool

from minibrain.api.deps import QueueDep, SessionDep, StoreDep
from minibrain.api.schemas import JobDetail, JobEventInfo, JobInfo
from minibrain.api.views import job_detail, job_info
from minibrain.registry.models import FINAL_JOB_STATUSES, Artifact, Job, JobEvent
from minibrain.registry.service import NotFoundError, get_minibrain

router = APIRouter(prefix="/api", tags=["jobs"])

EVENT_POLL_SECONDS = 0.5
EVENT_BATCH = 500


def get_job(session: SessionDep, job_id: int) -> Job:
    job = session.get(Job, job_id)
    if job is None:
        raise NotFoundError(f"job {job_id} not found")
    return job


@router.get("/jobs")
def list_jobs(
    session: SessionDep,
    minibrain: str | None = None,
    status: str | None = None,
    kind: str | None = None,
    limit: int = 50,
) -> list[JobInfo]:
    query = select(Job).order_by(Job.id.desc()).limit(max(1, min(limit, 500)))
    if minibrain is not None:
        query = query.where(Job.minibrain_id == get_minibrain(session, minibrain).id)
    if status is not None:
        query = query.where(Job.status == status)
    if kind is not None:
        query = query.where(Job.kind == kind)
    return [job_info(job) for job in session.scalars(query)]


@router.get("/jobs/{job_id}")
def read_job(job_id: int, session: SessionDep) -> JobDetail:
    return job_detail(get_job(session, job_id))


def event_info(event: JobEvent) -> JobEventInfo:
    return JobEventInfo(
        id=event.id, attempt=event.attempt, kind=event.kind, message=event.message, data=event.data, at=event.at
    )


def events_after(request: Request, job_id: int, after: int) -> tuple[list[JobEventInfo], bool]:
    with request.app.state.sessions() as session:
        job = get_job(session, job_id)
        query = select(JobEvent).where(JobEvent.job_id == job_id, JobEvent.id > after).order_by(JobEvent.id)
        events = [event_info(event) for event in session.scalars(query.limit(EVENT_BATCH))]
        return events, job.status in FINAL_JOB_STATUSES


@router.get("/jobs/{job_id}/events", response_class=StreamingResponse)
async def stream_events(job_id: int, request: Request, session: SessionDep, after: int = 0) -> StreamingResponse:
    get_job(session, job_id)

    async def stream() -> AsyncIterator[str]:
        cursor = after
        while not await request.is_disconnected():
            events, finished = await run_in_threadpool(events_after, request, job_id, cursor)
            for event in events:
                cursor = event.id
                yield f"id: {event.id}\ndata: {event.model_dump_json()}\n\n"
            if finished and not events:
                yield f"event: end\ndata: {json.dumps({'job': job_id})}\n\n"
                return
            if not events:
                await asyncio.sleep(EVENT_POLL_SECONDS)

    headers = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    return StreamingResponse(stream(), media_type="text/event-stream", headers=headers)


@router.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: int, session: SessionDep, queue: QueueDep) -> JobInfo:
    job = get_job(session, job_id)
    queue.cancel(session, job)
    session.commit()
    return job_info(job)


@router.post("/jobs/{job_id}/retry", status_code=201)
def retry_job(job_id: int, session: SessionDep, queue: QueueDep) -> JobInfo:
    again = queue.retry(session, get_job(session, job_id))
    session.commit()
    return job_info(again)


@router.get("/artifacts/{artifact_id}", response_class=StreamingResponse)
def download(artifact_id: str, session: SessionDep, store: StoreDep) -> StreamingResponse:
    artifact = session.get(Artifact, artifact_id)
    if artifact is None or not store.has(artifact_id):
        raise NotFoundError(f"artifact {artifact_id} not found")
    filename = artifact.name if artifact.packing == "file" else f"{artifact.name}.tar"
    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    return StreamingResponse(store.chunks(artifact_id), media_type="application/octet-stream", headers=headers)
