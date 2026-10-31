import secrets
import threading
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Protocol

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session, sessionmaker

from minibrain.jobs.policy import LEASE, backoff, policy
from minibrain.registry.models import (
    FINAL_JOB_STATUSES,
    AttemptOutcome,
    Job,
    JobAttempt,
    JobEvent,
    JobStatus,
    Worker,
    now,
)

TERMINAL = tuple(str(status) for status in FINAL_JOB_STATUSES)


class LeaseError(Exception):
    pass


class JobStateError(Exception):
    pass


class Effects(Protocol):
    def on_success(self, session: Session, job: Job) -> None: ...

    def on_failure(self, session: Session, job: Job) -> None: ...

    def on_retry(self, session: Session, job: Job) -> None: ...


@dataclass(frozen=True)
class Claim:
    job_id: int
    kind: str
    attempt: int
    token: str
    params: dict[str, Any]
    lease_seconds: int


@dataclass(frozen=True)
class Beat:
    cancel: bool
    lease_expires_at: datetime


@dataclass(frozen=True)
class EventIn:
    kind: str
    message: str = ""
    data: dict[str, Any] | None = None


@dataclass
class WorkerInfo:
    id: str
    host: str
    kinds: list[str] = field(default_factory=list)
    gpus: int = 1


def add_event(session: Session, job: Job, kind: str, message: str, data: dict[str, Any] | None = None) -> None:
    session.add(JobEvent(job_id=job.id, attempt=job.attempt, kind=kind, message=message, data=data))


def enqueue(
    session: Session,
    kind: str,
    params: dict[str, Any],
    minibrain_id: int | None = None,
    version_id: int | None = None,
    idempotency_key: str | None = None,
    priority: int = 0,
    retry_of: int | None = None,
    model_id: str | None = None,
) -> Job:
    if idempotency_key is not None:
        existing = session.scalar(
            select(Job).where(
                Job.idempotency_key == idempotency_key,
                Job.status.in_([JobStatus.QUEUED, JobStatus.RUNNING]),
            )
        )
        if existing is not None:
            return existing
    rules = policy(kind)
    job = Job(
        kind=kind,
        params=params,
        minibrain_id=minibrain_id,
        version_id=version_id,
        model_id=model_id,
        needs_gpu=rules.needs_gpu,
        max_attempts=rules.max_attempts,
        idempotency_key=idempotency_key,
        priority=priority,
        retry_of=retry_of,
        outputs={},
    )
    session.add(job)
    session.flush()
    add_event(session, job, "state", "queued")
    return job


def same_error_twice(job: Job, error: str) -> bool:
    finished = [attempt for attempt in job.attempts if attempt.outcome != AttemptOutcome.RUNNING]
    return len(finished) >= 2 and finished[-2].error == error


class SqlJobQueue:
    def __init__(
        self,
        sessions: sessionmaker[Session],
        effects: Effects,
        clock: Callable[[], datetime] = now,
        delay: Callable[[int], timedelta] = backoff,
    ) -> None:
        self.sessions = sessions
        self.effects = effects
        self.clock = clock
        self.delay = delay
        self.lock = threading.Lock()

    def register(self, worker: WorkerInfo) -> None:
        with self.lock, self.sessions() as session:
            record = session.get(Worker, worker.id) or Worker(id=worker.id, host=worker.host)
            record.host = worker.host
            record.kinds = worker.kinds
            record.gpus = worker.gpus
            record.seen_at = self.clock()
            session.add(record)
            session.commit()

    def claim(self, worker: WorkerInfo) -> Claim | None:
        with self.lock, self.sessions() as session:
            moment = self.clock()
            busy = session.scalar(
                select(func.count(Job.id)).where(
                    Job.status == JobStatus.RUNNING, Job.lease_owner == worker.id, Job.needs_gpu.is_(True)
                )
            )
            candidate = select(Job.id).where(
                Job.status == JobStatus.QUEUED, Job.run_after <= moment, Job.kind.in_(worker.kinds)
            )
            if (busy or 0) >= worker.gpus:
                candidate = candidate.where(Job.needs_gpu.is_(False))
            candidate = (
                candidate.order_by(Job.priority.desc(), Job.id)
                .limit(1)
                .with_for_update(skip_locked=True)
                .scalar_subquery()
            )
            token = secrets.token_urlsafe(24)
            claimed = session.scalar(
                update(Job)
                .where(Job.id == candidate, Job.status == JobStatus.QUEUED)
                .values(
                    status=JobStatus.RUNNING,
                    attempt=Job.attempt + 1,
                    lease_owner=worker.id,
                    lease_token=token,
                    lease_expires_at=moment + LEASE,
                    started_at=func.coalesce(Job.started_at, moment),
                )
                .returning(Job.id)
            )
            if claimed is None:
                session.rollback()
                return None
            job = session.get(Job, claimed)
            if job is None:
                raise JobStateError(f"job {claimed} vanished during claim")
            session.refresh(job)
            session.add(JobAttempt(job_id=job.id, number=job.attempt, worker=worker.id, started_at=moment))
            add_event(session, job, "state", f"attempt {job.attempt} started on {worker.host}")
            session.commit()
            return Claim(
                job_id=job.id,
                kind=job.kind,
                attempt=job.attempt,
                token=token,
                params=dict(job.params),
                lease_seconds=int(LEASE.total_seconds()),
            )

    def leased(self, session: Session, job_id: int, token: str) -> Job:
        job = session.scalar(select(Job).where(Job.id == job_id).with_for_update())
        if job is None or job.status != JobStatus.RUNNING or job.lease_token != token:
            raise LeaseError(f"job {job_id} is not leased with this token")
        return job

    def heartbeat(self, job_id: int, token: str) -> Beat:
        with self.lock, self.sessions() as session:
            job = self.leased(session, job_id, token)
            expires = self.clock() + LEASE
            job.lease_expires_at = expires
            worker = session.get(Worker, job.lease_owner) if job.lease_owner else None
            if worker is not None:
                worker.seen_at = self.clock()
            session.commit()
            return Beat(cancel=job.cancel_requested, lease_expires_at=expires)

    def record(self, job_id: int, token: str, events: Sequence[EventIn]) -> None:
        with self.lock, self.sessions() as session:
            job = self.leased(session, job_id, token)
            for event in events:
                add_event(session, job, event.kind, event.message, event.data)
                progress = (event.data or {}).get("progress")
                if event.kind == "progress" and isinstance(progress, int | float):
                    job.progress = max(0.0, min(float(progress), 1.0))
            session.commit()

    def current_attempt(self, job: Job) -> JobAttempt:
        attempt = next((item for item in job.attempts if item.number == job.attempt), None)
        if attempt is None:
            raise JobStateError(f"job {job.id} has no attempt {job.attempt}")
        return attempt

    def close_attempt(self, job: Job, outcome: str, error: str | None, retryable: bool | None, log: str | None) -> None:
        attempt = self.current_attempt(job)
        attempt.outcome = outcome
        attempt.error = error
        attempt.retryable = retryable
        attempt.log_artifact_id = log or attempt.log_artifact_id
        attempt.finished_at = self.clock()

    def release(self, job: Job) -> None:
        job.lease_owner = None
        job.lease_token = None
        job.lease_expires_at = None

    def finish(self, session: Session, job: Job, status: JobStatus, error: str | None = None) -> None:
        job.status = status
        job.error = error
        job.finished_at = self.clock()
        self.release(job)
        add_event(session, job, "state", status if error is None else f"{status}: {error}")
        if status == JobStatus.SUCCEEDED:
            self.effects.on_success(session, job)
        else:
            self.effects.on_failure(session, job)

    def complete(
        self, job_id: int, token: str, result: dict[str, Any], outputs: dict[str, str], log: str | None
    ) -> None:
        with self.lock, self.sessions() as session:
            job = self.leased(session, job_id, token)
            if job.cancel_requested:
                self.close_attempt(job, AttemptOutcome.CANCELLED, None, None, log)
                self.finish(session, job, JobStatus.CANCELLED)
            else:
                self.close_attempt(job, AttemptOutcome.SUCCEEDED, None, None, log)
                job.result = result
                job.outputs = outputs
                job.progress = 1.0
                self.finish(session, job, JobStatus.SUCCEEDED)
            session.commit()

    def settle_failure(self, session: Session, job: Job, error: str, retryable: bool) -> None:
        if job.cancel_requested:
            self.finish(session, job, JobStatus.CANCELLED)
            return
        if retryable and job.attempt < job.max_attempts and not same_error_twice(job, error):
            wait = self.delay(job.attempt)
            job.status = JobStatus.QUEUED
            job.run_after = self.clock() + wait
            job.error = error
            self.release(job)
            add_event(session, job, "state", f"retrying in {int(wait.total_seconds())}s: {error}")
            return
        self.finish(session, job, JobStatus.FAILED, error)

    def fail(self, job_id: int, token: str, error: str, retryable: bool, log: str | None) -> None:
        with self.lock, self.sessions() as session:
            job = self.leased(session, job_id, token)
            outcome = AttemptOutcome.CANCELLED if job.cancel_requested else AttemptOutcome.FAILED
            self.close_attempt(job, outcome, error, retryable, log)
            self.settle_failure(session, job, error, retryable)
            session.commit()

    def grace(self) -> int:
        with self.lock, self.sessions() as session:
            extended = self.clock() + LEASE
            running = list(session.scalars(select(Job).where(Job.status == JobStatus.RUNNING)))
            for job in running:
                if job.lease_expires_at is None or job.lease_expires_at < extended:
                    job.lease_expires_at = extended
            session.commit()
            return len(running)

    def expire(self) -> int:
        with self.lock, self.sessions() as session:
            moment = self.clock()
            running = list(session.scalars(select(Job).where(Job.status == JobStatus.RUNNING)))
            expired = 0
            for job in running:
                over_time = job.started_at is not None and moment - job.started_at > policy(job.kind).max_runtime
                lost = job.lease_expires_at is not None and job.lease_expires_at < moment
                if not (lost or over_time):
                    continue
                error = "ran past its time limit" if over_time else "the worker stopped responding"
                self.close_attempt(job, AttemptOutcome.LOST, error, True, None)
                self.settle_failure(session, job, error, retryable=not over_time)
                expired += 1
            session.commit()
            return expired

    def cancel(self, session: Session, job: Job) -> None:
        if job.status in TERMINAL:
            raise JobStateError(f"job {job.id} is already {job.status}")
        if job.status == JobStatus.QUEUED:
            self.finish(session, job, JobStatus.CANCELLED)
        else:
            job.cancel_requested = True
            add_event(session, job, "state", "cancel requested")

    def retry(self, session: Session, job: Job) -> Job:
        if job.status not in (JobStatus.FAILED, JobStatus.CANCELLED):
            raise JobStateError(f"job {job.id} is {job.status}; only failed or cancelled jobs can be retried")
        again = enqueue(
            session,
            job.kind,
            dict(job.params),
            minibrain_id=job.minibrain_id,
            version_id=job.version_id,
            priority=job.priority,
            retry_of=job.id,
            model_id=job.model_id,
        )
        self.effects.on_retry(session, again)
        return again
