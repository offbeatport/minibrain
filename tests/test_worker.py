import threading
import time

import pytest

from minibrain import worker as worker_module
from tests.conftest import Harness
from tests.test_flow import SLUG, add_version, create_with_dataset

FAKE = {"prepare": "minibrain.data.prepare", "train": "tests.fake_job", "eval": "tests.fake_job"}


def queued_training(harness: Harness) -> None:
    create_with_dataset(harness)
    add_version(harness, "lora")


def train_job(harness: Harness) -> dict:
    job_id = harness.client.get(f"/api/jobs?minibrain={SLUG}&kind=train").json()[0]["id"]
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
    versions = harness.client.get(f"/api/minibrains/{SLUG}/versions").json()
    assert versions[0]["status"] == "evaluating"
    assert harness.worker(kinds=["eval"], modules=FAKE).run_once()
    assert harness.client.get(f"/api/minibrains/{SLUG}/versions").json()[0]["status"] == "ready"


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
    assert harness.client.get(f"/api/minibrains/{SLUG}/versions").json()[0]["status"] == "failed"
