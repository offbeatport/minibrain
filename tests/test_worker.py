import threading
import time
from datetime import timedelta
from typing import Any

import pytest

from minibrain import worker as worker_module
from minibrain.jobs import queue as queue_module
from minibrain.jobs.effects import DomainEffects
from minibrain.registry.files import MissingArtifactError
from tests.conftest import Harness
from tests.test_flow import SLUG, add_version, create_with_dataset

pytestmark = pytest.mark.both_stores

FAKE = {"train": "tests.fake_job", "eval": "tests.fake_job"}


def queued_training(harness: Harness) -> None:
    create_with_dataset(harness)
    add_version(harness, "lora")


def train_job(harness: Harness) -> dict:
    job_id = harness.client.get(f"/api/jobs?model={SLUG}&kind=train").json()["items"][0]["id"]
    return harness.client.get(f"/api/jobs/{job_id}").json()


def test_worker_runs_training_and_hands_over_to_eval(harness: Harness) -> None:
    queued_training(harness)
    assert harness.worker(kinds=["train"], modules=FAKE).run_once()
    job = train_job(harness)
    assert job["status"] == "succeeded"
    assert job["outputs"]["adapter"]
    assert job["attempts"][0]["log"]
    log = harness.client.get(f"/api/artifacts/{job['attempts'][0]['log']}").text
    assert "half way" in log
    versions = harness.client.get(f"/api/models/{SLUG}/versions").json()
    assert versions[0]["status"] == "evaluating"
    assert harness.worker(kinds=["eval"], modules=FAKE).run_once()
    assert harness.client.get(f"/api/models/{SLUG}/versions").json()[0]["status"] == "ready"


def test_final_exit_code_fails_without_retry(harness: Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    queued_training(harness)
    monkeypatch.setenv("FAKE_JOB_EXIT", "2")
    monkeypatch.setenv("FAKE_JOB_ERROR", "recipe is invalid")
    harness.worker(kinds=["train"], modules=FAKE).run_once()
    job = train_job(harness)
    assert (job["status"], job["error"]) == ("failed", "recipe is invalid")
    assert job["attempts"][0]["retryable"] is False


def test_crash_is_retried(harness: Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    queued_training(harness)
    monkeypatch.setenv("FAKE_JOB_EXIT", "1")
    harness.worker(kinds=["train"], modules=FAKE).run_once()
    job = train_job(harness)
    assert (job["status"], job["attempts"][0]["retryable"]) == ("queued", True)


def test_cancel_stops_the_child_process(harness: Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    queued_training(harness)
    monkeypatch.setenv("FAKE_JOB_SECONDS", "60")
    monkeypatch.setattr(worker_module, "HEARTBEAT_SECONDS", 0.5)
    runner = threading.Thread(target=harness.worker(kinds=["train"], modules=FAKE).run_once)
    started = time.monotonic()
    runner.start()
    while train_job(harness)["status"] != "running":
        time.sleep(0.1)
    harness.client.post(f"/api/jobs/{train_job(harness)['id']}/cancel")
    runner.join(timeout=30)
    assert time.monotonic() - started < 25
    assert train_job(harness)["status"] == "cancelled"
    assert harness.client.get(f"/api/models/{SLUG}/versions").json()[0]["status"] == "failed"


def test_a_result_that_cannot_be_saved_fails_the_job_instead_of_leaving_it_running(
    harness: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    queued_training(harness)

    def missing(_effects: DomainEffects, _session: Any, _job: Any) -> None:
        raise MissingArtifactError("dataset version 1234 has no artifact")

    monkeypatch.setattr(DomainEffects, "trained", missing)
    assert harness.worker(kinds=["train"], modules=FAKE).run_once()
    job = train_job(harness)
    assert (job["status"], job["attempts"][0]["outcome"]) == ("failed", "failed")
    assert "1234 has no artifact" in job["error"]
    assert harness.client.get(f"/api/models/{SLUG}/versions").json()[0]["status"] == "failed"


def test_lease_is_kept_while_the_worker_uploads_the_adapter(harness: Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    queued_training(harness)
    monkeypatch.setattr(queue_module, "LEASE", timedelta(seconds=1))
    monkeypatch.setattr(worker_module, "HEARTBEAT_SECONDS", 0.2)
    worker = harness.worker(kinds=["train"], modules=FAKE)
    upload = worker.outputs

    def slow_outputs(kind: str, attempt_dir: Any) -> dict[str, str]:
        for _ in range(15):
            time.sleep(0.2)
            harness.queue.expire()
        return upload(kind, attempt_dir)

    monkeypatch.setattr(worker, "outputs", slow_outputs)
    assert worker.run_once()
    job = train_job(harness)
    assert (job["status"], [attempt["outcome"] for attempt in job["attempts"]]) == ("succeeded", ["succeeded"])


class Unreachable:
    def request(self, method: str, url: str, **kwargs: Any) -> Any:
        raise worker_module.httpx.ConnectError("main is gone")

    def stream(self, method: str, url: str, **kwargs: Any) -> Any:
        raise worker_module.httpx.ConnectError("main is gone")


def test_orphaned_worker_stops_without_waiting_out_retries(harness: Harness) -> None:
    config = harness.worker_config()
    worker = worker_module.Worker(config, client=worker_module.MainClient(config, http=Unreachable()))
    stop = threading.Event()
    thread = threading.Thread(target=worker.run_forever, args=(stop,))
    started = time.monotonic()
    thread.start()
    time.sleep(0.2)
    stop.set()
    thread.join(timeout=5)
    assert not thread.is_alive() and time.monotonic() - started < 3
