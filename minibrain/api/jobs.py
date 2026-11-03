import asyncio
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import ColumnElement, func, or_, select
from sqlalchemy.orm import Session, joinedload
from starlette.concurrency import run_in_threadpool

from minibrain.api.deps import QueueDep, SessionDep, StoreDep
from minibrain.api.schemas import JobDetail, JobEventInfo, JobFacets, JobInfo, JobPage
from minibrain.api.views import job_detail, job_info
from minibrain.registry.models import FINAL_JOB_STATUSES, Artifact, Job, JobEvent, Minibrain
from minibrain.registry.service import NotFoundError

router = APIRouter(prefix="/api", tags=["jobs"])

EVENT_POLL_SECONDS = 0.5
EVENT_BATCH = 500
JOB_PAGE = 50
JOB_PAGE_MAX = 200

JobOrder = Literal["newest", "oldest"]
Facet = Literal["status", "minibrain"]


def get_job(session: SessionDep, job_id: int) -> Job:
    job = session.get(Job, job_id)
    if job is None:
        raise NotFoundError(f"job {job_id} not found")
    return job


@dataclass(frozen=True)
class JobFilter:
    minibrains: list[str]
    kinds: list[str]
    statuses: list[str]
    ids: list[int]
    q: str
    since: datetime | None
    until: datetime | None


def job_filter(
    minibrain: Annotated[list[str] | None, Query()] = None,
    kind: Annotated[list[str] | None, Query()] = None,
    status: Annotated[list[str] | None, Query()] = None,
    ids: Annotated[list[int] | None, Query(alias="id")] = None,
    q: Annotated[str, Query(max_length=200)] = "",
    since: datetime | None = None,
    until: datetime | None = None,
) -> JobFilter:
    return JobFilter(
        minibrains=minibrain or [],
        kinds=kind or [],
        statuses=status or [],
        ids=ids or [],
        q=q.strip(),
        since=since,
        until=until,
    )


FilterDep = Annotated[JobFilter, Depends(job_filter)]


def text_match(text: str) -> ColumnElement[bool]:
    term = text.removeprefix("#")
    named = select(Minibrain.id).where(
        or_(Minibrain.name.icontains(term, autoescape=True), Minibrain.slug.icontains(term, autoescape=True))
    )
    matches = [Job.minibrain_id.in_(named), Job.model_id.icontains(term, autoescape=True)]
    if term.isdigit():
        matches.append(Job.id == int(term))
    return or_(*matches)


def conditions(filters: JobFilter, skip: Facet | None = None) -> list[ColumnElement[bool]]:
    where: list[ColumnElement[bool]] = []
    if filters.minibrains and skip != "minibrain":
        chosen = select(Minibrain.id).where(Minibrain.slug.in_(filters.minibrains))
        where.append(Job.minibrain_id.in_(chosen))
    if filters.statuses and skip != "status":
        where.append(Job.status.in_(filters.statuses))
    if filters.kinds:
        where.append(Job.kind.in_(filters.kinds))
    if filters.ids:
        where.append(Job.id.in_(filters.ids))
    if filters.q:
        where.append(text_match(filters.q))
    if filters.since is not None:
        where.append(Job.created_at >= filters.since)
    if filters.until is not None:
        where.append(Job.created_at < filters.until)
    return where


def count_jobs(session: Session, where: list[ColumnElement[bool]]) -> int:
    return session.scalar(select(func.count()).select_from(Job).where(*where)) or 0


@router.get("/jobs")
def list_jobs(
    session: SessionDep,
    filters: FilterDep,
    limit: int = JOB_PAGE,
    cursor: Annotated[str | None, Query(pattern=r"^\d{1,18}$")] = None,
    order: JobOrder = "newest",
) -> JobPage:
    where = conditions(filters)
    size = max(1, min(limit, JOB_PAGE_MAX))
    newest = order == "newest"
    query = select(Job).options(joinedload(Job.minibrain), joinedload(Job.version)).where(*where)
    if cursor is not None:
        query = query.where(Job.id < int(cursor) if newest else Job.id > int(cursor))
    query = query.order_by(Job.id.desc() if newest else Job.id.asc()).limit(size + 1)
    jobs = list(session.scalars(query))
    shown = jobs[:size]
    more = len(jobs) > size
    return JobPage(
        items=[job_info(job) for job in shown],
        next_cursor=str(shown[-1].id) if more else None,
        total=count_jobs(session, where),
    )


@router.get("/jobs/facets")
def job_facets(session: SessionDep, filters: FilterDep) -> JobFacets:
    by_status = select(Job.status, func.count()).where(*conditions(filters, "status")).group_by(Job.status)
    by_minibrain = (
        select(Minibrain.slug, func.count())
        .select_from(Job)
        .join(Minibrain, Job.minibrain_id == Minibrain.id)
        .where(*conditions(filters, "minibrain"))
        .group_by(Minibrain.slug)
    )
    return JobFacets(
        total=count_jobs(session, conditions(filters)),
        statuses={status: count for status, count in session.execute(by_status)},
        minibrains={slug: count for slug, count in session.execute(by_minibrain)},
    )


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
