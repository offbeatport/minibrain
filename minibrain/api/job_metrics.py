from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from minibrain.api.access import viewer
from minibrain.api.deps import SessionDep
from minibrain.api.jobs import get_job
from minibrain.api.schemas import (
    CountedMetrics,
    EvalPoint,
    JobMetrics,
    PreviousTraining,
    TrainingMetrics,
    TrainPoint,
    TransferMetrics,
)
from minibrain.jobs.metrics import (
    COUNTED,
    MAX_POINTS,
    PREVIOUS_POINTS,
    STEP,
    TRANSFER,
    latest_data,
    previous_training,
    rising_from,
    thinned,
    training_run,
)
from minibrain.registry.models import Job, JobKind

router = APIRouter(prefix="/api", tags=["jobs"])


def number(data: dict[str, Any], key: str) -> float | None:
    value = data.get(key)
    return float(value) if isinstance(value, int | float) else None


def whole(data: dict[str, Any], key: str) -> int | None:
    value = number(data, key)
    return None if value is None else int(value)


def train_point(data: dict[str, Any]) -> TrainPoint:
    return TrainPoint(
        step=int(data["step"]),
        epoch=number(data, "epoch"),
        loss=number(data, "loss"),
        learning_rate=number(data, "learning_rate"),
        grad_norm=number(data, "grad_norm"),
        tokens_per_second=number(data, "tokens_per_second"),
        memory_bytes=whole(data, "memory_bytes"),
    )


def mean_speed(points: list[dict[str, Any]]) -> float | None:
    speeds = [float(p["tokens_per_second"]) for p in points if isinstance(p.get("tokens_per_second"), int | float)]
    return round(sum(speeds) / len(speeds), 1) if speeds else None


def peak_memory(points: list[dict[str, Any]]) -> int | None:
    return max((int(p["memory_bytes"]) for p in points if isinstance(p.get("memory_bytes"), int)), default=None)


def training(session: Session, job: Job) -> TrainingMetrics | None:
    run = training_run(session, job.id)
    if not run.points and not run.evals:
        return None
    latest = latest_data(session, job.id, (STEP,)) or {}
    return TrainingMetrics(
        points=[train_point(point) for point in thinned(run.points, MAX_POINTS)],
        evals=[EvalPoint.model_validate(point) for point in run.evals],
        step=whole(latest, "step"),
        steps=whole(latest, "steps"),
        epoch=number(latest, "epoch"),
        eta_seconds=number(latest, "eta_seconds") if job.finished_at is None else None,
        tokens_per_second=number(latest, "tokens_per_second") if job.finished_at is None else mean_speed(run.points),
        memory_bytes=peak_memory(run.points),
        rising_from=rising_from(run.points, run.evals),
    )


def previous(session: Session, job: Job) -> PreviousTraining | None:
    earlier = previous_training(session, job)
    if earlier is None:
        return None
    run = training_run(session, earlier.id)
    if not run.points:
        return None
    return PreviousTraining(
        job_id=earlier.id,
        version=earlier.version.number if earlier.version else None,
        points=[train_point(point) for point in thinned(run.points, PREVIOUS_POINTS)],
        evals=[EvalPoint.model_validate(point) for point in run.evals],
    )


def transfer(session: Session, job: Job) -> TransferMetrics | None:
    data = latest_data(session, job.id, (TRANSFER,))
    if data is None:
        return None
    return TransferMetrics(
        bytes=whole(data, "bytes") or 0,
        total=whole(data, "total") or 0,
        bytes_per_second=number(data, "bytes_per_second") if job.finished_at is None else None,
        file=str(data["file"]) if data.get("file") else None,
    )


def counted(session: Session, job: Job) -> CountedMetrics | None:
    data = latest_data(session, job.id, COUNTED)
    if data is None:
        return None
    return CountedMetrics(done=whole(data, "done") or 0, total=whole(data, "total") or 0)


@router.get("/jobs/{job_id}/metrics", dependencies=[Depends(viewer)])
def job_metrics(job_id: int, session: SessionDep) -> JobMetrics:
    job = get_job(session, job_id)
    if job.kind == JobKind.TRAIN:
        return JobMetrics(training=training(session, job), previous=previous(session, job))
    if job.kind in (JobKind.EVAL, JobKind.JUDGE):
        return JobMetrics(counted=counted(session, job))
    return JobMetrics(transfer=transfer(session, job))
