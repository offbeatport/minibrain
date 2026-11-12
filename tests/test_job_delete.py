from typing import Any

from sqlalchemy import func, select

from minibrain.auth.roles import Role
from minibrain.jobs.queue import enqueue
from minibrain.registry.models import (
    Artifact,
    AuditEvent,
    Job,
    JobAttempt,
    JobEvent,
    JobKind,
    JobStatus,
    Model,
    Version,
)
from tests.conftest import Harness
from tests.test_accounts import csrf
from tests.test_flow import SLUG, add_version, create_with_dataset, finish
from tests.test_job_actions import add_job, audited, running_job

NAME = "Support Triage"


def exists(harness: Harness, job_id: int) -> bool:
    with harness.sessions() as session:
        return session.get(Job, job_id) is not None


def events_of(harness: Harness, job_id: int) -> int:
    with harness.sessions() as session:
        return session.scalar(select(func.count()).select_from(JobEvent).where(JobEvent.job_id == job_id)) or 0


def trained(harness: Harness) -> tuple[int, int]:
    create_with_dataset(harness)
    add_version(harness, "lora")
    train = finish(harness, "train")
    evaluation = finish(harness, "eval", accuracy=0.9)
    return train, evaluation


def failed_with_log(harness: Harness, kind: str = JobKind.VERIFY) -> tuple[int, str]:
    with harness.sessions() as session:
        job = enqueue(session, kind, {})
        session.commit()
        job_id = job.id
    claim = harness.claim([kind])
    assert claim is not None and claim["job_id"] == job_id
    log = harness.upload(f"log of {job_id}".encode(), "log", "file", "log.txt")
    body = {"token": claim["token"], "error": "boom", "retryable": False, "log": log}
    assert harness.internal(f"/jobs/{job_id}/fail", body).status_code == 204
    return job_id, log


def outcome(result: dict[str, Any]) -> tuple[int, bool, str | None, str | None]:
    return result["id"], result["done"], result["status"], result.get("reason")


def test_failed_and_cancelled_jobs_go_with_their_events(harness: Harness) -> None:
    failed = add_job(harness, JobStatus.FAILED)
    cancelled = add_job(harness, JobStatus.CANCELLED)
    assert events_of(harness, failed) > 0
    assert harness.client.get(f"/api/jobs/{failed}").json()["delete_refusal"] is None
    assert harness.client.delete(f"/api/jobs/{failed}").status_code == 204
    assert harness.client.delete(f"/api/jobs/{cancelled}").status_code == 204
    assert not exists(harness, failed) and not exists(harness, cancelled)
    assert events_of(harness, failed) == 0
    assert harness.client.get(f"/api/jobs/{failed}").status_code == 404
    assert harness.client.delete(f"/api/jobs/{failed}").status_code == 404


def test_finished_housekeeping_jobs_can_be_deleted(harness: Harness) -> None:
    done = add_job(harness, JobStatus.SUCCEEDED)
    assert harness.client.delete(f"/api/jobs/{done}").status_code == 204


def test_a_job_that_built_or_scored_a_live_version_is_kept(harness: Harness) -> None:
    train, evaluation = trained(harness)
    for job_id in (train, evaluation):
        refused = harness.client.delete(f"/api/jobs/{job_id}")
        assert refused.status_code == 409
        assert refused.json()["detail"] == f"Used by {NAME} v1. Delete the version first."
        assert harness.client.get(f"/api/jobs/{job_id}").json()["delete_refusal"] == refused.json()["detail"]
    assert exists(harness, train) and exists(harness, evaluation)


def test_jobs_of_a_deleted_version_or_model_can_be_deleted(harness: Harness) -> None:
    train, evaluation = trained(harness)
    assert harness.client.delete(f"/api/models/{SLUG}/versions/1").status_code == 204
    assert harness.client.get(f"/api/jobs/{train}").json()["delete_refusal"] is None
    results = harness.client.post("/api/jobs/delete", json={"ids": [train, evaluation]}).json()
    assert [outcome(result) for result in results] == [
        (train, True, "succeeded", None),
        (evaluation, True, "succeeded", None),
    ]


def test_a_train_job_a_copied_version_still_uses_is_kept(harness: Harness) -> None:
    train, _ = trained(harness)
    with harness.sessions() as session:
        baseline = session.scalars(select(Version).join(Model).where(Model.slug == SLUG, Version.number == 0)).one()
        baseline.duplicated_from = {"slug": "other", "name": "Other", "number": 1, "job": train}
        session.commit()
    assert harness.client.delete(f"/api/models/{SLUG}/versions/1").status_code == 204
    refused = harness.client.delete(f"/api/jobs/{train}")
    assert refused.status_code == 409 and refused.json()["detail"] == f"Used by {NAME} v0. Delete the version first."


def test_active_jobs_need_cancel_jobs(harness: Harness) -> None:
    running = running_job(harness)
    queued = add_job(harness)
    for job_id in (queued, running):
        refused = harness.client.delete(f"/api/jobs/{job_id}")
        assert refused.status_code == 409 and "cancel it first" in refused.json()["detail"]
    assert harness.client.delete(f"/api/jobs/{queued}", params={"cancel_jobs": True}).status_code == 204
    assert not exists(harness, queued)
    assert [detail["reason"] for _, detail in audited(harness, "job.cancel")] == ["delete"]


def test_a_running_job_goes_only_once_its_worker_stops(harness: Harness) -> None:
    running = running_job(harness)
    with harness.sessions() as session:
        token = session.scalar(select(Job.lease_token).where(Job.id == running))
    accepted = harness.client.delete(f"/api/jobs/{running}", params={"cancel_jobs": True})
    assert accepted.status_code == 202
    assert (accepted.json()["status"], accepted.json()["delete_requested"]) == ("running", True)
    harness.app.state.teardowns.run_once()
    assert exists(harness, running)
    assert harness.client.post(f"/api/jobs/{running}/retry").status_code == 409
    again = harness.client.delete(f"/api/jobs/{running}")
    assert again.status_code == 202
    beat = harness.internal(f"/jobs/{running}/heartbeat", {"token": token})
    assert beat.json()["cancel"] is True
    body = {"token": token, "error": "cancelled", "retryable": False}
    assert harness.internal(f"/jobs/{running}/fail", body).status_code == 204
    harness.app.state.teardowns.run_once()
    assert not exists(harness, running)
    assert len(audited(harness, "job.delete")) == 1


def test_bulk_delete_reports_each_job(harness: Harness) -> None:
    train, _ = trained(harness)
    failed = add_job(harness, JobStatus.FAILED)
    queued = add_job(harness)
    results = harness.client.post("/api/jobs/delete", json={"ids": [failed, train, queued, 9999, failed]}).json()
    assert [outcome(result) for result in results] == [
        (failed, True, "failed", None),
        (train, False, "succeeded", "in_use"),
        (queued, False, "queued", "active"),
        (9999, False, None, "not_found"),
    ]
    assert results[1]["error"] == f"Used by {NAME} v1. Delete the version first."
    assert exists(harness, queued) and exists(harness, train) and not exists(harness, failed)
    forced = harness.client.post("/api/jobs/delete", json={"ids": [queued], "cancel_jobs": True}).json()
    assert [outcome(result) for result in forced] == [(queued, True, "queued", None)]
    assert not exists(harness, queued)


def test_deleting_is_audited_with_a_snapshot(harness: Harness) -> None:
    train, evaluation = trained(harness)
    assert harness.client.delete(f"/api/models/{SLUG}/versions/1").status_code == 204
    assert harness.client.delete(f"/api/jobs/{train}").status_code == 204
    assert audited(harness, "job.delete") == [
        (
            f"job:{train}",
            {
                "name": f"Job #{train}",
                "kind": "train",
                "model": SLUG,
                "model_name": NAME,
                "version": 1,
                "status": "succeeded",
            },
        )
    ]
    activity = harness.client.get(f"/api/model-pages/{SLUG}/activity").json()["events"]
    said = {event["text"]: event["link"] for event in activity if event["action"].startswith("job.")}
    assert said == {f"deleted job #{train}": None}
    with harness.sessions() as session:
        assert session.scalar(select(AuditEvent).where(AuditEvent.target == f"job:{train}")) is not None
    assert exists(harness, evaluation)


def test_deleting_removes_the_log_and_scratch_nothing_else_uses(harness: Harness) -> None:
    first, log = failed_with_log(harness)
    _, other = failed_with_log(harness)
    assert log != other
    scratch = harness.settings.work_dir() / f"job-{first}"
    (scratch / "checkpoints").mkdir(parents=True)
    store = harness.app.state.store
    assert harness.client.get(f"/api/jobs/{first}").json()["attempts"][0]["log"] == log
    assert harness.client.delete(f"/api/jobs/{first}").status_code == 204
    assert not scratch.exists()
    assert not store.has(log)
    with harness.sessions() as session:
        assert session.get(Artifact, log) is None
        assert session.get(Artifact, other) is not None
    assert store.has(other)


def test_a_log_another_job_shares_is_kept(harness: Harness) -> None:
    first, log = failed_with_log(harness)
    second = add_job(harness, JobStatus.FAILED)
    with harness.sessions() as session:
        session.add(JobAttempt(job_id=second, number=1, worker="test-worker", log_artifact_id=log))
        session.commit()
    assert harness.client.delete(f"/api/jobs/{first}").status_code == 204
    assert harness.app.state.store.has(log)
    assert harness.client.get(f"/api/jobs/{second}").json()["attempts"][0]["log"] == log


def test_a_retried_job_can_be_deleted_and_its_retry_stays(harness: Harness) -> None:
    failed = add_job(harness, JobStatus.FAILED)
    again = harness.client.post(f"/api/jobs/{failed}/retry").json()
    assert harness.client.delete(f"/api/jobs/{failed}").status_code == 204
    assert harness.client.get(f"/api/jobs/{again['id']}").json()["retry_of"] is None


def test_a_version_shows_its_earlier_job_once_a_later_one_goes(harness: Harness) -> None:
    train, evaluation = trained(harness)
    with harness.sessions() as session:
        version = session.scalars(select(Version).join(Model).where(Model.slug == SLUG, Version.number == 1)).one()
        retry = enqueue(session, JobKind.EVAL, {}, version.model_id, version.id)
        retry.status = JobStatus.FAILED
        session.commit()
        failed = retry.id
    shown = {item["number"]: item for item in harness.client.get(f"/api/models/{SLUG}/versions").json()}
    assert shown[1]["job"]["id"] == failed
    assert harness.client.delete(f"/api/jobs/{failed}").status_code == 204
    shown = {item["number"]: item for item in harness.client.get(f"/api/models/{SLUG}/versions").json()}
    assert shown[1]["job"]["id"] == evaluation
    assert shown[1]["status"] == "ready"
    assert exists(harness, train)


def test_only_builders_delete_jobs(harness: Harness) -> None:
    failed = add_job(harness, JobStatus.FAILED)
    viewer = harness.person(Role.VIEWER)
    assert viewer.delete(f"/api/jobs/{failed}", headers=csrf(viewer)).status_code == 403
    assert viewer.post("/api/jobs/delete", json={"ids": [failed]}, headers=csrf(viewer)).status_code == 403
    builder = harness.person(Role.BUILDER)
    assert builder.delete(f"/api/jobs/{failed}", headers=csrf(builder)).status_code == 204
