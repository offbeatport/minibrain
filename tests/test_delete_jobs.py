from datetime import timedelta
from typing import Any

from sqlalchemy import delete, select, update

from minibrain.registry.models import AuditEvent, Job, JobStatus, Version, now
from tests.conftest import Harness, give_data
from tests.test_flow import SLUG, add_version, create_with_dataset
from tests.test_teardown import BASE, add_base, add_custom, age, row

NAME = "Support Triage"


def started(harness: Harness, kind: str = "train", worker: str = "test-worker") -> dict[str, Any]:
    claim = harness.claim([kind], worker)
    assert claim is not None, f"no {kind} job queued"
    return claim


def train(harness: Harness, slug: str = SLUG, worker: str = "test-worker") -> dict[str, Any]:
    created = harness.client.post(f"/api/models/{slug}/versions", json={"kind": "lora", "max_rows": 100})
    assert created.status_code == 201, created.text
    return started(harness, worker=worker)


def heartbeat(harness: Harness, claim: dict[str, Any]) -> bool:
    response = harness.internal(f"/jobs/{claim['job_id']}/heartbeat", {"token": claim["token"]})
    assert response.status_code == 200, response.text
    return bool(response.json()["cancel"])


def stop(harness: Harness, claim: dict[str, Any]) -> int:
    body = {"token": claim["token"], "error": "cancelled", "retryable": False}
    return harness.internal(f"/jobs/{claim['job_id']}/fail", body).status_code


def job(harness: Harness, job_id: int) -> Job:
    with harness.sessions() as session:
        found = session.get(Job, job_id)
        assert found is not None
        session.expunge(found)
        return found


def audits(harness: Harness, action: str) -> list[AuditEvent]:
    with harness.sessions() as session:
        query = select(AuditEvent).where(AuditEvent.action == action).order_by(AuditEvent.id)
        return list(session.scalars(query))


def version_numbers(harness: Harness, slug: str = SLUG) -> list[int]:
    return [item["number"] for item in harness.client.get(f"/api/models/{slug}/versions").json()]


def test_deleting_a_version_with_a_running_job_lists_it_and_waits_for_the_cancel(harness: Harness) -> None:
    create_with_dataset(harness)
    claim = train(harness)
    refused = harness.client.delete(f"/api/models/{SLUG}/versions/1")
    assert refused.status_code == 409
    body = refused.json()
    assert body["detail"] == f"{SLUG}@1 has a job running; cancel it first ({NAME} v1: Train, running)"
    assert [(item["id"], item["kind"], item["status"], item["version"]) for item in body["jobs"]] == [
        (claim["job_id"], "train", "running", 1)
    ]
    accepted = harness.client.delete(f"/api/models/{SLUG}/versions/1", params={"cancel_jobs": True})
    assert accepted.status_code == 202 and accepted.json()["status"] == "deleting"
    [cancelled] = audits(harness, "job.cancel")
    assert cancelled.target == f"job:{claim['job_id']}" and cancelled.detail["reason"] == "delete"
    harness.settle()
    assert 1 in version_numbers(harness)
    assert harness.client.post(f"/api/jobs/{claim['job_id']}/retry").status_code == 409
    assert heartbeat(harness, claim)
    assert stop(harness, claim) == 204
    harness.settle()
    assert 1 not in version_numbers(harness)
    kept = job(harness, claim["job_id"])
    assert (kept.status, kept.version_id, kept.version_number, kept.model_slug) == ("cancelled", None, 1, SLUG)
    [begun] = audits(harness, "version.delete")
    [done] = audits(harness, "version.delete_finished")
    assert begun.detail["jobs"] == [claim["job_id"]] and done.target == f"{SLUG}@1"
    assert done.detail["outcome"] == "done"


def test_a_version_whose_jobs_are_only_queued_goes_at_once(harness: Harness) -> None:
    create_with_dataset(harness)
    add_version(harness, "lora")
    with harness.sessions() as session:
        queued = session.scalar(select(Job.id).where(Job.kind == "train", Job.status == JobStatus.QUEUED))
    assert queued is not None
    response = harness.client.delete(f"/api/models/{SLUG}/versions/1", params={"cancel_jobs": True})
    assert response.status_code == 204
    assert 1 not in version_numbers(harness)
    assert job(harness, queued).status == "cancelled"


def test_deleting_a_model_cancels_its_jobs_and_waits_until_they_stop(harness: Harness) -> None:
    create_with_dataset(harness)
    claim = train(harness)
    refused = harness.client.delete(f"/api/models/{SLUG}")
    assert refused.status_code == 409 and "Train, running" in refused.json()["detail"]
    assert [item["id"] for item in refused.json()["jobs"]] == [claim["job_id"]]
    accepted = harness.client.delete(f"/api/models/{SLUG}", params={"cancel_jobs": True})
    assert accepted.status_code == 202
    teardown = accepted.json()["teardown"]
    assert (teardown["label"], teardown["jobs"]) == ("Cancelling 1 job", [claim["job_id"]])
    harness.settle()
    found = row(harness, SLUG)
    assert found is not None
    assert found["teardown"]["waiting"] == [f"job #{claim['job_id']} (Train) to stop"]
    assert stop(harness, claim) == 204
    harness.settle()
    assert row(harness, SLUG) is None
    kept = job(harness, claim["job_id"])
    assert (kept.status, kept.model_id, kept.model_slug, kept.version_number) == ("cancelled", None, SLUG, 1)
    assert audits(harness, "model.delete")[0].detail["jobs"] == [claim["job_id"]]
    assert [event.target for event in audits(harness, "job.cancel")] == [f"job:{claim['job_id']}"]


def test_a_cancelled_job_that_never_stops_fails_the_delete_for_review(harness: Harness) -> None:
    create_with_dataset(harness)
    claim = train(harness)
    harness.client.delete(f"/api/models/{SLUG}", params={"cancel_jobs": True})
    age(harness, 11)
    harness.app.state.teardowns.run_once()
    found = row(harness, SLUG)
    assert found is not None
    teardown = found["teardown"]
    assert (teardown["state"], teardown["label"], teardown["jobs"]) == ("failed", "Delete failed", [claim["job_id"]])
    assert teardown["error"] == f"Still waiting after 10 minutes for job #{claim['job_id']} (Train) to stop."
    assert audits(harness, "model.delete_finished")[0].detail["outcome"] == "failed"
    assert stop(harness, claim) == 204
    retried = harness.client.delete(f"/api/models/{SLUG}")
    assert retried.status_code == 202 and retried.json()["teardown"]["label"] == "Deleting"
    harness.settle()
    assert row(harness, SLUG) is None


def test_deleting_a_base_with_its_models_cancels_every_job_first(harness: Harness) -> None:
    add_base(harness)
    slug = add_custom(harness, "Helper")
    give_data(harness, slug)
    assert harness.client.post(f"/api/models/{slug}/dataset-versions").status_code == 201
    claim = train(harness, slug)
    verified = harness.client.post(f"/api/base-models/{BASE}/verify")
    assert verified.status_code == 202, verified.text
    with harness.sessions() as session:
        verify = session.scalar(select(Job.id).where(Job.base_model_id == BASE, Job.status == JobStatus.QUEUED))
    assert verify is not None
    params: dict[str, Any] = {"cascade": True}
    refused = harness.client.delete(f"/api/base-models/{BASE}", params=params)
    assert refused.status_code == 409
    assert [item["id"] for item in refused.json()["jobs"]] == [verify]
    accepted = harness.client.delete(f"/api/base-models/{BASE}", params=params | {"cancel_jobs": True})
    assert accepted.status_code == 202, accepted.text
    assert job(harness, verify).status == "cancelled"
    assert sorted(event.target for event in audits(harness, "job.cancel")) == sorted(
        [f"job:{verify}", f"job:{claim['job_id']}"]
    )
    harness.settle()
    assert row(harness, slug) is not None and row(harness, BASE, "base") is not None
    assert stop(harness, claim) == 204
    harness.settle()
    assert row(harness, slug) is None and row(harness, BASE, "base") is None
    assert job(harness, claim["job_id"]).status == "cancelled"
    assert audits(harness, "model.delete")[0].detail["jobs"] == [verify, claim["job_id"]]


def test_bulk_delete_cancels_the_jobs_of_every_selected_model(harness: Harness) -> None:
    create_with_dataset(harness)
    first = train(harness)
    add_base(harness)
    other = add_custom(harness, "Helper")
    give_data(harness, other)
    assert harness.client.post(f"/api/models/{other}/dataset-versions").status_code == 201
    second = train(harness, other, "second-worker")
    params = {"cancel_jobs": True, "undeploy": True}
    assert harness.client.delete(f"/api/models/{SLUG}/versions/1", params=params).status_code == 202
    assert harness.client.delete(f"/api/models/{other}", params=params).status_code == 202
    assert heartbeat(harness, first) and heartbeat(harness, second)
    assert stop(harness, first) == 204 and stop(harness, second) == 204
    harness.settle()
    assert 1 not in version_numbers(harness) and row(harness, other) is None
    assert {job(harness, claim["job_id"]).status for claim in (first, second)} == {"cancelled"}


def test_a_worker_reporting_for_a_deleted_version_is_told_to_stop(harness: Harness) -> None:
    create_with_dataset(harness)
    claim = train(harness)
    with harness.sessions() as session:
        session.execute(delete(Version).where(Version.number == 1))
        session.commit()
    events = {"token": claim["token"], "events": [{"kind": "event", "message": "step 1", "data": {"progress": 0.5}}]}
    assert harness.internal(f"/jobs/{claim['job_id']}/events", events).status_code == 204
    assert heartbeat(harness, claim)
    body = {"token": claim["token"], "result": {"summary": {}}, "outputs": {}}
    assert harness.internal(f"/jobs/{claim['job_id']}/complete", body).status_code == 204
    kept = job(harness, claim["job_id"])
    assert (kept.status, kept.version_number, kept.model_slug) == ("cancelled", 1, SLUG)
    late = harness.internal(f"/jobs/{claim['job_id']}/complete", body)
    assert late.status_code == 409
    assert job(harness, claim["job_id"]).status == "cancelled"


def test_a_late_report_after_the_version_is_gone_is_refused_without_harm(harness: Harness) -> None:
    create_with_dataset(harness)
    claim = train(harness)
    harness.client.delete(f"/api/models/{SLUG}/versions/1", params={"cancel_jobs": True})
    with harness.sessions() as session:
        lapsed = now() - timedelta(minutes=1)
        session.execute(update(Job).where(Job.id == claim["job_id"]).values(lease_expires_at=lapsed))
        session.commit()
    assert harness.queue.expire() == 1
    harness.settle()
    assert 1 not in version_numbers(harness)
    assert stop(harness, claim) == 409
    assert heartbeat_refused(harness, claim)
    assert job(harness, claim["job_id"]).status == "cancelled"


def heartbeat_refused(harness: Harness, claim: dict[str, Any]) -> bool:
    response = harness.internal(f"/jobs/{claim['job_id']}/heartbeat", {"token": claim["token"]})
    return response.status_code == 409
