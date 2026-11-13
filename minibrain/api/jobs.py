import asyncio
import json
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy import ColumnElement, false, func, or_, select
from sqlalchemy.orm import Session, joinedload
from starlette.concurrency import run_in_threadpool

from minibrain.api.access import builder, sees_rows, viewer
from minibrain.api.deps import QueueDep, SessionDep, SettingsDep, StoreDep
from minibrain.api.job_facts import TRAINING_METHODS, job_setup
from minibrain.api.owners import custom_owned, custom_token, split_token
from minibrain.api.schemas import (
    JobActionResult,
    JobDeletion,
    JobDetail,
    JobEventInfo,
    JobFacets,
    JobIds,
    JobInfo,
    JobPage,
)
from minibrain.api.views import job_detail, job_info
from minibrain.auth.identity import current_actor
from minibrain.jobs.metrics import device_of
from minibrain.jobs.output import SOURCES, level_of
from minibrain.jobs.queue import JobStateError, SqlJobQueue, add_state
from minibrain.jobs.removal import DeleteRefused, Leftovers, active_refusal, kept_by, remove_job
from minibrain.registry.compute import pool_of_host
from minibrain.registry.models import (
    ACTIVE_JOB_STATUSES,
    FINAL_JOB_STATUSES,
    Artifact,
    AuditEvent,
    BaseModel,
    CatalogVariant,
    Job,
    JobEvent,
    JobKind,
    Model,
    Worker,
)
from minibrain.registry.service import NotFoundError
from minibrain.settings import Settings

router = APIRouter(prefix="/api")

EVENT_POLL_SECONDS = 0.5
EVENT_BATCH = 500
JOB_PAGE = 50
JOB_PAGE_MAX = 200

JobOrder = Literal["newest", "oldest"]
Facet = Literal["status", "model", "kind"]


def get_job(session: SessionDep, job_id: int) -> Job:
    job = session.get(Job, job_id)
    if job is None:
        raise NotFoundError(f"No job {job_id}")
    return job


@dataclass(frozen=True)
class JobFilter:
    models: list[str]
    kinds: list[str]
    methods: list[str]
    statuses: list[str]
    ids: list[int]
    q: str
    since: datetime | None
    until: datetime | None


def job_filter(
    model: Annotated[list[str] | None, Query()] = None,
    kind: Annotated[list[str] | None, Query()] = None,
    method: Annotated[list[str] | None, Query()] = None,
    status: Annotated[list[str] | None, Query()] = None,
    ids: Annotated[list[int] | None, Query(alias="id")] = None,
    q: Annotated[str, Query(max_length=200)] = "",
    since: datetime | None = None,
    until: datetime | None = None,
) -> JobFilter:
    return JobFilter(
        models=model or [],
        kinds=kind or [],
        methods=method or [],
        statuses=status or [],
        ids=ids or [],
        q=q.strip(),
        since=since,
        until=until,
    )


FilterDep = Annotated[JobFilter, Depends(job_filter)]


def text_match(text: str) -> ColumnElement[bool]:
    term = text.removeprefix("#")
    named = select(Model.id).where(
        or_(Model.name.icontains(term, autoescape=True), Model.slug.icontains(term, autoescape=True))
    )
    matches = [
        Job.model_id.in_(named),
        Job.model_name.icontains(term, autoescape=True),
        Job.model_slug.icontains(term, autoescape=True),
        Job.base_model_key.icontains(term, autoescape=True),
    ]
    if term.isdigit():
        matches.append(Job.id == int(term))
    return or_(*matches)


def method_match(methods: list[str]) -> ColumnElement[bool]:
    known = [method for method in methods if method in TRAINING_METHODS]
    return Job.kind == JobKind.TRAIN if known else false()


def conditions(filters: JobFilter, skip: Facet | None = None) -> list[ColumnElement[bool]]:
    where: list[ColumnElement[bool]] = []
    if filters.models and skip != "model":
        where.append(or_(*(custom_owned(Job.model_slug, Job.model_id, token) for token in filters.models)))
    if filters.statuses and skip != "status":
        where.append(Job.status.in_(filters.statuses))
    if filters.kinds and skip != "kind":
        where.append(Job.kind.in_(filters.kinds))
    if filters.methods:
        where.append(method_match(filters.methods))
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


@router.get("/jobs", dependencies=[Depends(viewer)], summary="List jobs")
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
    loads = (
        joinedload(Job.model),
        joinedload(Job.version),
        joinedload(Job.base_model).joinedload(BaseModel.variant).joinedload(CatalogVariant.model),
    )
    query = select(Job).options(*loads).where(*where)
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


@router.get("/jobs/facets", dependencies=[Depends(viewer)], summary="Count jobs by filter")
def job_facets(session: SessionDep, filters: FilterDep) -> JobFacets:
    by_status = select(Job.status, func.count()).where(*conditions(filters, "status")).group_by(Job.status)
    by_kind = select(Job.kind, func.count()).where(*conditions(filters, "kind")).group_by(Job.kind)
    token = custom_token(Job.model_slug, Job.model_id)
    by_model = (
        select(token, func.count(), func.max(Job.model_name))
        .where(Job.model_slug.is_not(None), *conditions(filters, "model"))
        .group_by(token)
    )
    found = list(session.execute(by_model))
    live = set(session.scalars(select(Model.slug).where(Model.slug.in_([row[0] for row in found]))))
    return JobFacets(
        total=count_jobs(session, conditions(filters)),
        statuses={status: count for status, count in session.execute(by_status)},
        models={str(slug): count for slug, count, _ in found},
        kinds={kind: count for kind, count in session.execute(by_kind)},
        deleted_models={str(slug): str(name or split_token(slug)[0]) for slug, _, name in found if slug not in live},
    )


def serving(job: Job) -> bool:
    model, version = job.model, job.version
    return model is not None and version is not None and model.deployed and model.current_version == version.number


def worker_place(session: Session, job: Job) -> dict[str, str | None]:
    attempt = max(job.attempts, key=lambda item: item.number, default=None)
    worker = session.get(Worker, attempt.worker) if attempt is not None else None
    if worker is None:
        return {"host": None, "pool": None}
    return {"host": worker.host, "pool": pool_of_host(session, worker.host)}


@router.get("/jobs/{job_id}", dependencies=[Depends(viewer)], summary="Read a job")
def read_job(job_id: int, session: SessionDep) -> JobDetail:
    job = get_job(session, job_id)
    context = {
        "device": device_of(session, job.id),
        **worker_place(session, job),
        "live": serving(job),
        "setup": job_setup(session, job),
    }
    found = job_detail(job).model_copy(update=context)
    return found if sees_rows() else found.model_copy(update={"result": None, "outputs": {}})


def event_info(event: JobEvent) -> JobEventInfo:
    return JobEventInfo(
        id=event.id,
        attempt=event.attempt,
        kind=event.kind,
        source=SOURCES.get(event.kind, "library"),
        level=level_of(event.level),
        name=event.name,
        message=event.message,
        data=event.data,
        at=event.at,
    )


def events_after(request: Request, job_id: int, after: int) -> tuple[list[JobEventInfo], bool]:
    with request.app.state.sessions() as session:
        job = get_job(session, job_id)
        query = select(JobEvent).where(JobEvent.job_id == job_id, JobEvent.id > after).order_by(JobEvent.id)
        events = [event_info(event) for event in session.scalars(query.limit(EVENT_BATCH))]
        return events, job.status in FINAL_JOB_STATUSES


@router.get("/jobs/{job_id}/events", response_class=StreamingResponse, dependencies=[Depends(viewer)])
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


def audit(session: Session, action: str, subject: Job, **detail: Any) -> None:
    owner = subject.model_slug or subject.base_model_key
    facts = {"name": f"Job #{subject.id}", "kind": subject.kind} | ({"model": owner} if owner else {}) | detail
    session.add(AuditEvent(actor=current_actor(), action=action, target=f"job:{subject.id}", detail=facts))


def cancel(session: Session, queue: SqlJobQueue, job: Job, **detail: Any) -> None:
    before = job.status
    queue.cancel(session, job)
    audit(session, "job.cancel", job, status=before, **detail)


def canceller(session: Session, queue: SqlJobQueue, cancel_jobs: bool) -> Callable[[Job], None] | None:
    if not cancel_jobs:
        return None
    return lambda job: cancel(session, queue, job, reason="delete")


def retry(session: Session, queue: SqlJobQueue, job: Job) -> Job:
    again = queue.retry(session, job)
    audit(session, "job.retry", job, job=again.id)
    return again


def each_job(session: Session, ids: list[int], act: Callable[[Job], Job | None]) -> list[JobActionResult]:
    results: list[JobActionResult] = []
    for job_id in dict.fromkeys(ids):
        job = session.get(Job, job_id)
        if job is None:
            results.append(JobActionResult(id=job_id, done=False, status=None, error=f"No job {job_id}"))
            continue
        try:
            made = act(job)
        except JobStateError as refused:
            results.append(JobActionResult(id=job_id, done=False, status=job.status, error=str(refused)))
            continue
        retried = job_info(made) if made is not None else None
        results.append(JobActionResult(id=job_id, done=True, status=job.status, retry=retried))
    session.commit()
    return results


@router.post("/jobs/cancel", dependencies=[Depends(builder)], summary="Cancel jobs")
def cancel_jobs(body: JobIds, session: SessionDep, queue: QueueDep) -> list[JobActionResult]:
    return each_job(session, body.ids, lambda job: cancel(session, queue, job))


@router.post("/jobs/retry", dependencies=[Depends(builder)], summary="Retry jobs")
def retry_jobs(body: JobIds, session: SessionDep, queue: QueueDep) -> list[JobActionResult]:
    return each_job(session, body.ids, lambda job: retry(session, queue, job))


@router.post("/jobs/{job_id}/cancel", dependencies=[Depends(builder)], summary="Cancel a job")
def cancel_job(job_id: int, session: SessionDep, queue: QueueDep) -> JobInfo:
    job = get_job(session, job_id)
    cancel(session, queue, job)
    session.commit()
    return job_info(job)


@router.post("/jobs/{job_id}/retry", status_code=201, dependencies=[Depends(builder)], summary="Retry a job")
def retry_job(job_id: int, session: SessionDep, queue: QueueDep) -> JobInfo:
    again = retry(session, queue, get_job(session, job_id))
    session.commit()
    return job_info(again)


def snapshot(job: Job) -> dict[str, Any]:
    facts: dict[str, Any] = {"status": job.status}
    if job.model_name:
        facts["model_name"] = job.model_name
    if job.version_number is not None:
        facts["version"] = job.version_number
    return facts


def stop_for_delete(session: Session, queue: SqlJobQueue, job: Job, cancel_jobs: bool) -> None:
    if job.status not in ACTIVE_JOB_STATUSES or job.cancel_requested:
        return
    if not cancel_jobs:
        raise DeleteRefused(active_refusal(job), "active")
    cancel(session, queue, job, reason="delete")


def delete(session: Session, queue: SqlJobQueue, settings: Settings, job: Job, cancel_jobs: bool) -> Leftovers:
    if job.delete_requested:
        return Leftovers()
    refusal = kept_by(job)
    if refusal is not None:
        raise DeleteRefused(refusal, "in_use")
    facts = snapshot(job)
    stop_for_delete(session, queue, job, cancel_jobs)
    audit(session, "job.delete", job, **facts)
    if job.status in ACTIVE_JOB_STATUSES:
        job.delete_requested = True
        add_state(session, job, "delete requested; it goes once it stops", "warning")
        return Leftovers()
    return remove_job(session, settings.work_dir(), job)


def delete_one(
    session: Session, queue: SqlJobQueue, settings: Settings, job_id: int, cancel_jobs: bool, leftovers: Leftovers
) -> JobActionResult:
    job = session.get(Job, job_id)
    if job is None:
        return JobActionResult(id=job_id, done=False, status=None, error=f"No job {job_id}", reason="not_found")
    before = job.status
    try:
        left = delete(session, queue, settings, job, cancel_jobs)
    except DeleteRefused as refused:
        return JobActionResult(id=job_id, done=False, status=before, error=str(refused), reason=refused.reason)
    leftovers.merge(left)
    return JobActionResult(id=job_id, done=True, status=before if left.removed else job.status)


@router.post("/jobs/delete", dependencies=[Depends(builder)], summary="Delete jobs")
def delete_jobs(
    body: JobDeletion, session: SessionDep, queue: QueueDep, settings: SettingsDep, store: StoreDep
) -> list[JobActionResult]:
    leftovers = Leftovers()
    ids = dict.fromkeys(body.ids)
    results = [delete_one(session, queue, settings, job_id, body.cancel_jobs, leftovers) for job_id in ids]
    session.commit()
    leftovers.clear(store)
    return results


@router.delete(
    "/jobs/{job_id}",
    status_code=204,
    response_model=None,
    responses={202: {"model": JobInfo, "description": "Cancelled; it goes once it stops"}},
    dependencies=[Depends(builder)],
    summary="Delete a job",
)
def delete_job(
    job_id: int,
    session: SessionDep,
    queue: QueueDep,
    settings: SettingsDep,
    store: StoreDep,
    cancel_jobs: bool = False,
) -> Response:
    job = get_job(session, job_id)
    leftovers = delete(session, queue, settings, job, cancel_jobs)
    session.commit()
    if not leftovers.removed:
        return JSONResponse(status_code=202, content=job_info(job).model_dump(mode="json"))
    leftovers.clear(store)
    return Response(status_code=204)


@router.get(
    "/artifacts/{artifact_id}",
    response_class=StreamingResponse,
    dependencies=[Depends(builder)],
    summary="Download a job artifact",
)
def download(artifact_id: str, session: SessionDep, store: StoreDep) -> StreamingResponse:
    artifact = session.get(Artifact, artifact_id)
    if artifact is None or not store.has(artifact_id):
        raise NotFoundError(f"artifact {artifact_id} not found")
    filename = artifact.name if artifact.packing == "file" else f"{artifact.name}.tar"
    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    return StreamingResponse(store.chunks(artifact_id), media_type="application/octet-stream", headers=headers)
