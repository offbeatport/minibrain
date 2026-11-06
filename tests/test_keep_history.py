from typing import Any

from minibrain.gateway.logs import LogEntry, database_sink
from minibrain.jobs.queue import enqueue
from minibrain.registry.models import Job, Model, RequestLog, now
from tests.conftest import Harness
from tests.test_flow import SLUG, add_version, create_with_dataset
from tests.test_teardown import BASE, add_base

NAME = "Support Triage"


def log(harness: Harness, model: str, model_id: int | None = None, version: int | None = None) -> None:
    entry = LogEntry(at=now(), key_id=None, model_id=model_id, model=model, version=version, status=200, latency_ms=5.0)
    database_sink(harness.sessions)([entry])


def cancel(harness: Harness, job_id: int) -> None:
    assert harness.client.post(f"/api/jobs/{job_id}/cancel").status_code == 200


def got(harness: Harness, path: str, **params: Any) -> Any:
    response = harness.client.get(path, params=params)
    assert response.status_code == 200, response.text
    return response.json()


def custom_with_history(harness: Harness) -> int:
    create_with_dataset(harness)
    trained = add_version(harness, "lora")
    with harness.sessions() as session:
        model_id = session.query(Model.id).filter(Model.slug == SLUG).scalar()
        job_id = session.query(Job.id).filter(Job.model_id == model_id, Job.kind == "train").scalar()
    assert job_id is not None and trained["number"] == 1
    cancel(harness, job_id)
    log(harness, SLUG, model_id, version=1)
    log(harness, SLUG, model_id, version=1)
    assert harness.client.delete(f"/api/models/{SLUG}").status_code == 202
    harness.settle()
    return job_id


def base_with_history(harness: Harness) -> int:
    add_base(harness)
    with harness.sessions() as session:
        job = enqueue(session, "download", {}, base_model_id=BASE)
        session.commit()
        job_id = job.id
    cancel(harness, job_id)
    log(harness, BASE)
    assert harness.client.delete(f"/api/base-models/{BASE}").status_code == 202
    harness.settle()
    return job_id


def test_deleting_a_custom_model_keeps_its_jobs_and_requests(harness: Harness) -> None:
    job_id = custom_with_history(harness)
    with harness.sessions() as session:
        kept = session.get(Job, job_id)
        assert kept is not None and kept.model_id is None and kept.version_id is None
        assert (kept.model_slug, kept.model_name, kept.version_number) == (SLUG, NAME, 1)
        logs = session.query(RequestLog).all()
        assert [(item.model_id, item.model_slug, item.model_name) for item in logs] == [(None, SLUG, NAME)] * 2
    shown = got(harness, f"/api/jobs/{job_id}")
    assert (shown["model"], shown["model_name"], shown["version"], shown["deleted"]) == (SLUG, NAME, 1, True)
    listed = got(harness, "/api/jobs", model=SLUG)["items"]
    assert job_id in [item["id"] for item in listed] and all(item["deleted"] for item in listed)
    facets = got(harness, "/api/jobs/facets", model=SLUG)
    assert facets["models"][SLUG] == len(listed) and facets["deleted_models"] == {SLUG: NAME}
    assert got(harness, "/api/jobs", q="triage")["total"] == len(listed)


def test_deleted_custom_models_show_and_filter_in_requests(harness: Harness) -> None:
    custom_with_history(harness)
    rows = got(harness, "/api/requests", model=SLUG)["items"]
    assert [(row["model_key"], row["model_name"], row["custom"], row["deleted"]) for row in rows] == [
        (SLUG, NAME, True, True)
    ] * 2
    assert got(harness, "/api/requests", version=f"{SLUG}@1")["total"] == 2
    facets = got(harness, "/api/requests/facets")
    [model] = facets["models"]
    assert (model["value"], model["label"], model["count"], model["deleted"]) == (SLUG, NAME, 2, True)
    [version] = facets["versions"]
    assert (version["value"], version["label"], version["deleted"]) == (f"{SLUG}@1", f"{NAME} v1", True)
    overview = got(harness, "/api/requests/overview", model=SLUG)
    [row] = overview["models"]
    assert (row["key"], row["label"], row["requests"], row["deleted"]) == (SLUG, NAME, 2, True)
    assert overview["series"][0]["deleted"] is True


def test_deleting_a_base_model_keeps_its_jobs_and_requests(harness: Harness) -> None:
    job_id = base_with_history(harness)
    shown = got(harness, f"/api/jobs/{job_id}")
    assert (shown["base_model"], shown["deleted"]) == (BASE, True)
    [row] = got(harness, "/api/requests", model=BASE)["items"]
    assert (row["model_key"], row["model_name"], row["custom"], row["deleted"]) == (BASE, "Tiny", False, True)
    [facet] = got(harness, "/api/requests/facets")["models"]
    assert (facet["value"], facet["label"], facet["deleted"]) == (BASE, "Tiny", True)
    [model] = got(harness, "/api/requests/overview")["models"]
    assert (model["key"], model["label"], model["deleted"]) == (BASE, "Tiny", True)


def test_a_job_whose_model_is_gone_is_not_retried(harness: Harness) -> None:
    custom = custom_with_history(harness)
    base = base_with_history(harness)
    for job_id in (custom, base):
        refused = harness.client.post(f"/api/jobs/{job_id}/retry")
        assert refused.status_code == 409 and "was deleted" in refused.json()["detail"]
    results = harness.client.post("/api/jobs/retry", json={"ids": [custom, base]}).json()
    assert [(item["done"], item["status"]) for item in results] == [(False, "cancelled")] * 2
    assert all("was deleted" in item["error"] for item in results)
