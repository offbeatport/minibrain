import threading
from datetime import datetime, timedelta

from minibrain.jobs.policy import LEASE
from minibrain.jobs.queue import WorkerInfo, enqueue
from minibrain.registry.models import Job, JobKind, now
from tests.conftest import Harness
from tests.test_flow import SLUG, add_version, create_with_dataset


class Clock:
    def __init__(self) -> None:
        self.moment = now() + timedelta(seconds=1)

    def __call__(self) -> datetime:
        return self.moment

    def advance(self, **delta: float) -> None:
        self.moment += timedelta(**delta)


def lora_job(harness: Harness) -> Clock:
    clock = Clock()
    harness.queue.clock = clock
    create_with_dataset(harness)
    add_version(harness, "lora")
    return clock


def job(harness: Harness, job_id: int) -> dict:
    return harness.client.get(f"/api/jobs/{job_id}").json()


def version_status(harness: Harness) -> str:
    return harness.client.get(f"/api/minibrains/{SLUG}/versions").json()[0]["status"]


def fail(harness: Harness, claim: dict, error: str = "boom", retryable: bool = True) -> int:
    body = {"token": claim["token"], "error": error, "retryable": retryable}
    return harness.internal(f"/jobs/{claim['job_id']}/fail", body).status_code


def complete(harness: Harness, claim: dict) -> int:
    body = {"token": claim["token"], "result": {"metrics": {}}, "outputs": {}}
    return harness.internal(f"/jobs/{claim['job_id']}/complete", body).status_code


def test_stale_token_is_fenced_after_the_lease_expires(harness: Harness) -> None:
    clock = lora_job(harness)
    first = harness.claim(["train"], worker_id="a")
    assert first is not None
    clock.advance(seconds=LEASE.total_seconds() + 1)
    assert harness.queue.expire() == 1
    detail = job(harness, first["job_id"])
    assert detail["status"] == "queued"
    assert detail["attempts"][0]["outcome"] == "lost"
    clock.advance(minutes=20)
    second = harness.claim(["train"], worker_id="b")
    assert second is not None and second["attempt"] == 2
    assert complete(harness, first) == 409
    assert job(harness, first["job_id"])["status"] == "running"


def test_retryable_failure_waits_then_runs_again(harness: Harness) -> None:
    clock = lora_job(harness)
    claim = harness.claim(["train"])
    assert claim is not None
    assert fail(harness, claim, "network blip") == 204
    assert job(harness, claim["job_id"])["status"] == "queued"
    assert harness.claim(["train"]) is None
    clock.advance(minutes=20)
    again = harness.claim(["train"])
    assert again is not None and again["attempt"] == 2


def test_same_error_twice_stops_retrying(harness: Harness) -> None:
    clock = lora_job(harness)
    claim = None
    for _ in range(2):
        claim = harness.claim(["train"])
        assert claim is not None
        fail(harness, claim, "CUDA out of memory")
        clock.advance(minutes=20)
    assert claim is not None
    detail = job(harness, claim["job_id"])
    assert detail["status"] == "failed"
    assert [attempt["outcome"] for attempt in detail["attempts"]] == ["failed", "failed"]
    assert version_status(harness) == "failed"


def test_final_failure_is_not_retried(harness: Harness) -> None:
    lora_job(harness)
    claim = harness.claim(["train"])
    assert claim is not None
    fail(harness, claim, "bad recipe", retryable=False)
    detail = job(harness, claim["job_id"])
    assert (detail["status"], detail["attempt"], detail["error"]) == ("failed", 1, "bad recipe")
    assert version_status(harness) == "failed"


def test_cancel_running_job_reaches_the_worker(harness: Harness) -> None:
    lora_job(harness)
    claim = harness.claim(["train"])
    assert claim is not None
    assert harness.client.post(f"/api/jobs/{claim['job_id']}/cancel").json()["cancel_requested"] is True
    beat = harness.internal(f"/jobs/{claim['job_id']}/heartbeat", {"token": claim["token"]}).json()
    assert beat["cancel"] is True
    fail(harness, claim, "cancelled", retryable=False)
    assert job(harness, claim["job_id"])["status"] == "cancelled"
    assert version_status(harness) == "failed"


def test_complete_after_cancel_still_cancels(harness: Harness) -> None:
    lora_job(harness)
    claim = harness.claim(["train"])
    assert claim is not None
    harness.client.post(f"/api/jobs/{claim['job_id']}/cancel")
    assert complete(harness, claim) == 204
    assert job(harness, claim["job_id"])["status"] == "cancelled"
    assert harness.claim(["eval"]) is None


def test_duplicate_complete_is_rejected_and_harmless(harness: Harness) -> None:
    lora_job(harness)
    claim = harness.claim(["train"])
    assert claim is not None
    adapter = harness.upload(b"not really a tar", "adapter", "tar", "adapter")
    body = {"token": claim["token"], "result": {"summary": {}}, "outputs": {"adapter": adapter}}
    assert harness.internal(f"/jobs/{claim['job_id']}/complete", body).status_code == 204
    assert harness.internal(f"/jobs/{claim['job_id']}/complete", body).status_code == 409
    evals = harness.client.get(f"/api/jobs?minibrain={SLUG}&kind=eval").json()
    assert len(evals) == 1


def test_unknown_output_artifacts_are_refused(harness: Harness) -> None:
    lora_job(harness)
    claim = harness.claim(["train"])
    assert claim is not None
    body = {"token": claim["token"], "result": {}, "outputs": {"adapter": "0" * 64}}
    assert harness.internal(f"/jobs/{claim['job_id']}/complete", body).status_code == 422
    assert job(harness, claim["job_id"])["status"] == "running"


def test_concurrent_claims_take_each_job_once(harness: Harness) -> None:
    with harness.sessions() as session:
        for index in range(20):
            enqueue(session, JobKind.PREPARE, {"n": index})
        session.commit()
    claimed: list[int] = []
    lock = threading.Lock()

    def take(worker_id: str) -> None:
        worker = WorkerInfo(id=worker_id, host="h", kinds=[JobKind.PREPARE], gpus=0)
        while (claim := harness.queue.claim(worker)) is not None:
            with lock:
                claimed.append(claim.job_id)

    threads = [threading.Thread(target=take, args=(f"w{index}",)) for index in range(6)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(claimed) == sorted(set(claimed))
    assert len(claimed) == 20


def test_gpu_slots_limit_heavy_jobs_only(harness: Harness) -> None:
    lora_job(harness)
    with harness.sessions() as session:
        enqueue(session, JobKind.PREPARE, {})
        session.commit()
    assert harness.claim(["train", "prepare"], worker_id="w") is not None
    second = harness.claim(["train", "prepare"], worker_id="w")
    assert second is not None and second["kind"] == "prepare"


def test_idempotency_key_dedupes_active_jobs(harness: Harness) -> None:
    with harness.sessions() as session:
        first = enqueue(session, JobKind.PREPARE, {}, idempotency_key="k")
        second = enqueue(session, JobKind.PREPARE, {}, idempotency_key="k")
        session.commit()
        assert first.id == second.id


def test_retry_creates_a_linked_job(harness: Harness) -> None:
    lora_job(harness)
    claim = harness.claim(["train"])
    assert claim is not None
    fail(harness, claim, "bad", retryable=False)
    again = harness.client.post(f"/api/jobs/{claim['job_id']}/retry").json()
    assert (again["status"], again["retry_of"]) == ("queued", claim["job_id"])
    assert version_status(harness) == "training"
    assert harness.client.post(f"/api/jobs/{again['id']}/retry").status_code == 409


def test_time_limit_fails_without_retry(harness: Harness) -> None:
    clock = lora_job(harness)
    claim = harness.claim(["train"])
    assert claim is not None
    for _ in range(25):
        clock.advance(hours=1)
        harness.internal(f"/jobs/{claim['job_id']}/heartbeat", {"token": claim["token"]})
    harness.queue.expire()
    detail = job(harness, claim["job_id"])
    assert (detail["status"], detail["error"]) == ("failed", "ran past its time limit")


def test_restart_grace_keeps_running_jobs(harness: Harness) -> None:
    clock = lora_job(harness)
    claim = harness.claim(["train"])
    assert claim is not None
    clock.advance(seconds=LEASE.total_seconds() + 30)
    harness.queue.grace()
    assert harness.queue.expire() == 0
    assert job(harness, claim["job_id"])["status"] == "running"


def test_events_stream_until_the_job_ends(harness: Harness) -> None:
    lora_job(harness)
    claim = harness.claim(["train"])
    assert claim is not None
    events = [{"kind": "log", "message": "step 1"}, {"kind": "progress", "message": "", "data": {"progress": 0.25}}]
    harness.internal(f"/jobs/{claim['job_id']}/events", {"token": claim["token"], "events": events})
    assert job(harness, claim["job_id"])["progress"] == 0.25
    fail(harness, claim, "stop", retryable=False)
    stream = harness.client.get(f"/api/jobs/{claim['job_id']}/events").text
    assert "step 1" in stream and stream.rstrip().endswith(f'data: {{"job": {claim["job_id"]}}}')


def test_job_rows_cascade_with_the_minibrain(harness: Harness) -> None:
    lora_job(harness)
    claim = harness.claim(["train"])
    assert claim is not None
    fail(harness, claim, "x", retryable=False)
    assert harness.client.delete(f"/api/minibrains/{SLUG}").status_code == 204
    with harness.sessions() as session:
        assert session.get(Job, claim["job_id"]) is None
