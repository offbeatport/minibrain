from fastapi import APIRouter
from fastapi.responses import PlainTextResponse
from sqlalchemy import func, select, text

from minibrain.api.deps import SessionDep
from minibrain.registry.models import Job, JobStatus, now

router = APIRouter(tags=["ops"])


@router.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/readyz")
def readyz(session: SessionDep) -> dict[str, str]:
    session.execute(text("SELECT 1"))
    return {"status": "ready"}


@router.get("/metrics", response_class=PlainTextResponse)
def metrics(session: SessionDep) -> str:
    lines = [
        "# HELP minibrain_jobs Jobs by kind and status.",
        "# TYPE minibrain_jobs gauge",
    ]
    counts = session.execute(select(Job.kind, Job.status, func.count(Job.id)).group_by(Job.kind, Job.status))
    for kind, status, count in counts:
        lines.append(f'minibrain_jobs{{kind="{kind}",status="{status}"}} {count}')
    oldest = session.scalar(select(func.min(Job.run_after)).where(Job.status == JobStatus.QUEUED))
    wait = 0.0 if oldest is None else max((now() - oldest).total_seconds(), 0.0)
    lines += [
        "# HELP minibrain_queue_oldest_seconds Age of the oldest runnable queued job.",
        "# TYPE minibrain_queue_oldest_seconds gauge",
        f"minibrain_queue_oldest_seconds {wait:.1f}",
    ]
    return "\n".join(lines) + "\n"
