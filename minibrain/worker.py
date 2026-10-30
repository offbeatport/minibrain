import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from huey import SqliteHuey
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from minibrain.registry.db import make_sessions
from minibrain.registry.models import Job, JobKind, JobStatus, VersionStatus, now
from minibrain.registry.service import create_job
from minibrain.settings import Settings, load_settings

MODULES = {JobKind.TRAIN: "minibrain.ml.train", JobKind.EVAL: "minibrain.ml.evaluate"}
POLL_SECONDS = 1.0
QUIET_ENV = {
    "HF_HUB_DISABLE_PROGRESS_BARS": "1",
    "HF_DATASETS_DISABLE_PROGRESS_BARS": "1",
    "TOKENIZERS_PARALLELISM": "false",
    "PYTHONUNBUFFERED": "1",
}

huey = SqliteHuey("minibrain", filename=str(load_settings().queue_path))


@huey.task()
def run_job(job_id: int) -> None:
    execute(load_settings(), job_id)


def execute(settings: Settings, job_id: int) -> None:
    sessions = make_sessions(settings.database_url)
    command = start(sessions, job_id)
    if command is None:
        return
    exit_code = run_process(sessions, job_id, command)
    follow_up = finish(sessions, settings, job_id, exit_code)
    if follow_up is not None:
        run_job(follow_up)


def start(sessions: sessionmaker[Session], job_id: int) -> tuple[list[str], Path] | None:
    with sessions() as session:
        job = session.get(Job, job_id)
        if job is None:
            return None
        if job.status == JobStatus.CANCELLING:
            job.status = JobStatus.CANCELLED
            job.version.status = VersionStatus.FAILED
            job.finished_at = now()
            session.commit()
            return None
        job.status = JobStatus.RUNNING
        job.started_at = now()
        session.commit()
        return [sys.executable, "-m", MODULES[JobKind(job.kind)], str(job.id)], Path(job.log_path)


def cancel_requested(sessions: sessionmaker[Session], job_id: int) -> bool:
    with sessions() as session:
        job = session.get(Job, job_id)
        return job is None or job.status == JobStatus.CANCELLING


def run_process(sessions: sessionmaker[Session], job_id: int, command: tuple[list[str], Path]) -> int | None:
    arguments, log_path = command
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("wb") as log:
        process = subprocess.Popen(
            arguments, stdout=log, stderr=subprocess.STDOUT, start_new_session=True, env=os.environ | QUIET_ENV
        )
        while (exit_code := process.poll()) is None:
            time.sleep(POLL_SECONDS)
            if cancel_requested(sessions, job_id):
                os.killpg(process.pid, signal.SIGTERM)
                process.wait()
                return None
    return exit_code


def finish(sessions: sessionmaker[Session], settings: Settings, job_id: int, exit_code: int | None) -> int | None:
    with sessions() as session:
        job = session.get(Job, job_id)
        if job is None:
            return None
        job.finished_at = now()
        follow_up = None
        if exit_code is None:
            job.status = JobStatus.CANCELLED
            job.version.status = VersionStatus.FAILED
        elif exit_code != 0:
            job.status = JobStatus.FAILED
            job.error = f"exited with code {exit_code}; see the log"
            job.version.status = VersionStatus.FAILED
        else:
            job.status = JobStatus.DONE
            job.progress = 1.0
            follow_up = complete(session, settings, job)
        session.commit()
        return follow_up


def complete(session: Session, settings: Settings, job: Job) -> int | None:
    version = job.version
    if job.kind == JobKind.TRAIN:
        version.status = VersionStatus.EVALUATING
        follow_up = create_job(session, settings, version, JobKind.EVAL)
        return follow_up.id
    version.status = VersionStatus.READY
    if job.minibrain.current_version is None:
        job.minibrain.current_version = version.number
    return None


def fail_orphans(sessions: sessionmaker[Session]) -> int:
    with sessions() as session:
        orphans = list(session.scalars(select(Job).where(Job.status.in_([JobStatus.RUNNING, JobStatus.CANCELLING]))))
        for job in orphans:
            job.status = JobStatus.FAILED
            job.error = "the worker stopped while this job was running"
            job.finished_at = now()
            job.version.status = VersionStatus.FAILED
        session.commit()
        return len(orphans)


def consume() -> None:
    fail_orphans(make_sessions(load_settings().database_url))
    huey.create_consumer(workers=1, worker_type="thread").run()
