from typing import Any

from sqlalchemy import select

from minibrain.auth.roles import Role
from minibrain.jobs.queue import enqueue
from minibrain.registry.models import AuditEvent, Job, JobKind, JobStatus
from tests.conftest import Harness
from tests.test_accounts import csrf


def add_job(harness: Harness, status: JobStatus = JobStatus.QUEUED) -> int:
    with harness.sessions() as session:
        job = enqueue(session, JobKind.VERIFY, {})
        job.status = status
        session.commit()
        return job.id


def running_job(harness: Harness) -> int:
    job_id = add_job(harness)
    claim = harness.claim([JobKind.VERIFY])
    assert claim is not None and claim["job_id"] == job_id
    return job_id


def status_of(harness: Harness, job_id: int) -> str:
    return harness.client.get(f"/api/jobs/{job_id}").json()["status"]


def audited(harness: Harness, action: str) -> list[tuple[str, dict[str, Any]]]:
    with harness.sessions() as session:
        events = session.scalars(select(AuditEvent).where(AuditEvent.action == action).order_by(AuditEvent.id))
        return [
            (event.target, {key: value for key, value in event.detail.items() if key != "sign_in"}) for event in events
        ]


def outcome(result: dict[str, Any]) -> tuple[int, bool, str | None]:
    return result["id"], result["done"], result["status"]


def test_bulk_cancel_stops_what_it_can_and_says_why_not(harness: Harness) -> None:
    running = running_job(harness)
    queued = add_job(harness)
    left = add_job(harness)
    finished = add_job(harness, JobStatus.SUCCEEDED)
    response = harness.client.post("/api/jobs/cancel", json={"ids": [queued, running, finished, 9999, queued]})
    assert response.status_code == 200
    results = response.json()
    assert [outcome(result) for result in results] == [
        (queued, True, "cancelled"),
        (running, True, "running"),
        (finished, False, "succeeded"),
        (9999, False, None),
    ]
    assert "already succeeded" in results[2]["error"]
    assert results[3]["error"] == "job 9999 not found"
    assert harness.client.get(f"/api/jobs/{running}").json()["cancel_requested"] is True
    assert status_of(harness, left) == "queued"
    assert audited(harness, "job.cancel") == [
        (f"job:{queued}", {"name": f"Job #{queued}", "kind": "verify", "status": "queued"}),
        (f"job:{running}", {"name": f"Job #{running}", "kind": "verify", "status": "running"}),
    ]


def test_bulk_retry_queues_failed_and_cancelled_jobs_only(harness: Harness) -> None:
    failed = add_job(harness, JobStatus.FAILED)
    cancelled = add_job(harness, JobStatus.CANCELLED)
    queued = add_job(harness)
    results = harness.client.post("/api/jobs/retry", json={"ids": [failed, cancelled, queued]}).json()
    assert [outcome(result) for result in results] == [
        (failed, True, "failed"),
        (cancelled, True, "cancelled"),
        (queued, False, "queued"),
    ]
    again = [result["retry"] for result in results[:2]]
    assert [(job["status"], job["retry_of"]) for job in again] == [("queued", failed), ("queued", cancelled)]
    assert results[2]["retry"] is None and "only failed or cancelled" in results[2]["error"]
    assert [target for target, _ in audited(harness, "job.retry")] == [f"job:{failed}", f"job:{cancelled}"]
    assert [detail["job"] for _, detail in audited(harness, "job.retry")] == [job["id"] for job in again]


def test_single_actions_are_audited_like_bulk_ones(harness: Harness) -> None:
    queued = add_job(harness)
    assert harness.client.post(f"/api/jobs/{queued}/cancel").json()["status"] == "cancelled"
    again = harness.client.post(f"/api/jobs/{queued}/retry").json()
    assert [target for target, _ in audited(harness, "job.cancel")] == [f"job:{queued}"]
    assert audited(harness, "job.retry") == [
        (f"job:{queued}", {"name": f"Job #{queued}", "kind": "verify", "job": again["id"]})
    ]


def test_a_failed_job_in_a_bulk_retry_rolls_nothing_else_back(harness: Harness) -> None:
    first = add_job(harness, JobStatus.FAILED)
    second = add_job(harness, JobStatus.FAILED)
    results = harness.client.post("/api/jobs/retry", json={"ids": [first, 9999, second]}).json()
    assert [result["done"] for result in results] == [True, False, True]
    with harness.sessions() as session:
        retries = session.scalars(select(Job.retry_of).where(Job.retry_of.is_not(None)).order_by(Job.id))
        assert list(retries) == [first, second]


def test_bulk_actions_need_ids_and_the_builder_role(harness: Harness) -> None:
    queued = add_job(harness)
    assert harness.client.post("/api/jobs/cancel", json={"ids": []}).status_code == 422
    viewer = harness.person(Role.VIEWER)
    assert viewer.post("/api/jobs/cancel", json={"ids": [queued]}, headers=csrf(viewer)).status_code == 403
    assert viewer.post("/api/jobs/retry", json={"ids": [queued]}, headers=csrf(viewer)).status_code == 403
    builder = harness.person(Role.BUILDER)
    cancelled = builder.post("/api/jobs/cancel", json={"ids": [queued]}, headers=csrf(builder)).json()
    assert [outcome(result) for result in cancelled] == [(queued, True, "cancelled")]
    assert audited(harness, "job.cancel")[0][0] == f"job:{queued}"
