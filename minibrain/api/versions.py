from pathlib import Path

from fastapi import APIRouter
from sqlalchemy import select

from minibrain.api.deps import BackendDep, EnqueueDep, SessionDep, SettingsDep
from minibrain.api.schemas import (
    CompleteRequest,
    CompleteResponse,
    JobInfo,
    KeyCreate,
    KeyCreated,
    KeyInfo,
    LogChunk,
    MinibrainDetail,
    PromoteRequest,
    VersionCreate,
    VersionInfo,
)
from minibrain.api.views import detail, job_info, key_info, version_info
from minibrain.registry.models import ACTIVE_JOB_STATUSES, ApiKey, Job, JobKind, JobStatus, VersionKind
from minibrain.registry.service import (
    ConflictError,
    NotFoundError,
    create_job,
    create_key,
    create_version,
    get_minibrain,
    get_version,
    promote,
)
from minibrain.serve.resolve import completion_request, target_for
from minibrain.tasks.classify import parse_label

router = APIRouter(prefix="/api", tags=["versions"])

LOG_CHUNK_BYTES = 65536


@router.get("/minibrains/{slug}/versions")
def list_versions(slug: str, session: SessionDep) -> list[VersionInfo]:
    minibrain = get_minibrain(session, slug)
    versions = sorted(minibrain.versions, key=lambda version: version.number, reverse=True)
    return [version_info(minibrain, version) for version in versions]


@router.post("/minibrains/{slug}/versions", status_code=201)
def add_version(
    slug: str, body: VersionCreate, session: SessionDep, settings: SettingsDep, enqueue: EnqueueDep
) -> VersionInfo:
    minibrain = get_minibrain(session, slug)
    kind = VersionKind(body.kind)
    recipe = {key: value for key, value in (("max_rows", body.max_rows), ("epochs", body.epochs)) if value is not None}
    version = create_version(session, settings, minibrain, kind, recipe if kind == VersionKind.LORA else {})
    job = create_job(session, settings, version, JobKind.TRAIN if kind == VersionKind.LORA else JobKind.EVAL)
    session.commit()
    enqueue(job.id)
    return version_info(minibrain, version)


@router.post("/minibrains/{slug}/versions/{number}/promote")
def promote_version(
    slug: str, number: int, body: PromoteRequest, session: SessionDep, settings: SettingsDep
) -> MinibrainDetail:
    minibrain = get_minibrain(session, slug)
    promote(minibrain, get_version(minibrain, number), body.override)
    session.commit()
    return detail(settings, minibrain)


@router.get("/minibrains/{slug}/jobs")
def list_jobs(slug: str, session: SessionDep) -> list[JobInfo]:
    minibrain = get_minibrain(session, slug)
    return [job_info(job) for job in sorted(minibrain.jobs, key=lambda job: job.id, reverse=True)]


@router.get("/jobs")
def recent_jobs(session: SessionDep, limit: int = 20) -> list[JobInfo]:
    jobs = session.scalars(select(Job).order_by(Job.id.desc()).limit(max(1, min(limit, 200))))
    return [job_info(job) for job in jobs]


def get_job(session: SessionDep, job_id: int) -> Job:
    job = session.get(Job, job_id)
    if job is None:
        raise NotFoundError(f"job {job_id} not found")
    return job


@router.get("/jobs/{job_id}/log")
def read_log(job_id: int, session: SessionDep, offset: int = 0) -> LogChunk:
    path = Path(get_job(session, job_id).log_path)
    if not path.exists():
        return LogChunk(text="", offset=0)
    with path.open("rb") as log:
        log.seek(max(offset, 0))
        data = log.read(LOG_CHUNK_BYTES)
    return LogChunk(text=data.decode(errors="replace"), offset=max(offset, 0) + len(data))


@router.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: int, session: SessionDep) -> JobInfo:
    job = get_job(session, job_id)
    if job.status not in ACTIVE_JOB_STATUSES:
        raise ConflictError(f"job {job_id} is already {job.status}")
    job.status = JobStatus.CANCELLING
    session.commit()
    return job_info(job)


@router.post("/minibrains/{slug}/complete")
def complete(slug: str, body: CompleteRequest, session: SessionDep, backend: BackendDep) -> CompleteResponse:
    minibrain = get_minibrain(session, slug)
    target = target_for(minibrain, body.version)
    if target is None:
        raise ConflictError("no ready version to run; score or train one first")
    completion = backend.complete(completion_request(target, body.text, body.max_tokens))
    return CompleteResponse(
        model=target.name,
        output=completion.text,
        label=parse_label(completion.text, target.version.snapshot.labels),
        latency_ms=completion.seconds * 1000,
        prompt_tokens=completion.prompt_tokens,
        completion_tokens=completion.completion_tokens,
    )


@router.get("/minibrains/{slug}/keys")
def list_keys(slug: str, session: SessionDep) -> list[KeyInfo]:
    return [key_info(key) for key in get_minibrain(session, slug).keys]


@router.post("/minibrains/{slug}/keys", status_code=201)
def add_key(slug: str, body: KeyCreate, session: SessionDep) -> KeyCreated:
    key, secret = create_key(session, get_minibrain(session, slug), body.name)
    return KeyCreated(secret=secret, **key_info(key).model_dump())


@router.delete("/minibrains/{slug}/keys/{key_id}", status_code=204)
def delete_key(slug: str, key_id: int, session: SessionDep) -> None:
    minibrain = get_minibrain(session, slug)
    key = session.get(ApiKey, key_id)
    if key is None or key.minibrain_id != minibrain.id:
        raise NotFoundError(f"key {key_id} not found")
    session.delete(key)
    session.commit()
