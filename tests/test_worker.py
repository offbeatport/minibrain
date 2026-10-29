import threading
import time

import pytest

from minibrain import worker
from minibrain.registry.db import make_sessions
from minibrain.registry.models import Job, JobKind, JobStatus, Minibrain, Snapshot, Version, VersionStatus
from minibrain.registry.service import create_job
from minibrain.settings import Settings


@pytest.fixture
def queued_job(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> int:
    settings.home.mkdir(parents=True)
    monkeypatch.setattr(worker, "MODULES", {JobKind.TRAIN: "tests.fake_job", JobKind.EVAL: "tests.fake_job"})
    monkeypatch.setattr(worker, "run_job", lambda job_id: None)
    sessions = make_sessions(settings.database_url)
    with sessions() as session:
        minibrain = Minibrain(slug="m", name="m", task="classify", base_model="qwen3-0.6b")
        snapshot = Snapshot(minibrain=minibrain, hash="h", directory="d", counts={}, labels=[])
        version = Version(minibrain=minibrain, snapshot=snapshot, number=0, kind="lora", status="training")
        session.add(version)
        session.flush()
        job = create_job(session, settings, version, JobKind.TRAIN)
        session.commit()
        return job.id


def job_state(settings: Settings, job_id: int) -> tuple[str, str]:
    with make_sessions(settings.database_url)() as session:
        job = session.get(Job, job_id)
        assert job is not None
        return job.status, job.version.status


def test_successful_training_hands_over_to_eval(settings: Settings, queued_job: int) -> None:
    worker.execute(settings, queued_job)
    assert job_state(settings, queued_job) == (JobStatus.DONE, VersionStatus.EVALUATING)


def test_failed_process_fails_job_and_version(
    settings: Settings, queued_job: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FAKE_JOB_EXIT", "3")
    worker.execute(settings, queued_job)
    assert job_state(settings, queued_job) == (JobStatus.FAILED, VersionStatus.FAILED)


def test_cancel_kills_running_process(settings: Settings, queued_job: int, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FAKE_JOB_SECONDS", "30")

    def request_cancel() -> None:
        time.sleep(1.5)
        with make_sessions(settings.database_url)() as session:
            job = session.get(Job, queued_job)
            assert job is not None
            job.status = JobStatus.CANCELLING
            session.commit()

    threading.Thread(target=request_cancel).start()
    started = time.monotonic()
    worker.execute(settings, queued_job)
    assert time.monotonic() - started < 10
    assert job_state(settings, queued_job) == (JobStatus.CANCELLED, VersionStatus.FAILED)


def test_orphans_fail_on_restart(settings: Settings, queued_job: int) -> None:
    sessions = make_sessions(settings.database_url)
    worker.start(sessions, queued_job)
    assert worker.fail_orphans(sessions) == 1
    assert job_state(settings, queued_job) == (JobStatus.FAILED, VersionStatus.FAILED)
