from collections.abc import Callable
from datetime import timedelta

from sqlalchemy import select

from minibrain.jobs.queue import enqueue
from minibrain.registry.models import Job, JobKind, JobStatus, Model, now
from tests.conftest import Harness


def model_id(harness: Harness, name: str) -> int:
    slug = harness.client.post("/api/models", json={"labels": ["billing", "bug"], "name": name}).json()["slug"]
    with harness.sessions() as session:
        return session.scalars(select(Model.id).where(Model.slug == slug)).one()


def add_jobs(
    harness: Harness, count: int, kind: str = JobKind.TRAIN, owner: int | None = None, status: str | None = None
) -> list[int]:
    with harness.sessions() as session:
        jobs = [enqueue(session, kind, {"n": index}, model_id=owner) for index in range(count)]
        if status is not None:
            for job in jobs:
                job.status = status
        session.commit()
        return [job.id for job in jobs]


def page(harness: Harness, query: str = "") -> dict:
    response = harness.client.get(f"/api/jobs?{query}")
    assert response.status_code == 200, response.text
    return response.json()


def ids(body: dict) -> list[int]:
    return [item["id"] for item in body["items"]]


def walk(harness: Harness, query: str, between: Callable[[], object] | None = None) -> list[int]:
    seen: list[int] = []
    cursor = None
    while True:
        body = page(harness, query + (f"&cursor={cursor}" if cursor else ""))
        seen += ids(body)
        cursor = body["next_cursor"]
        if cursor is None:
            return seen
        if between is not None:
            between()


def test_pages_are_newest_first_without_duplicates_or_gaps_while_jobs_arrive(harness: Harness) -> None:
    original = add_jobs(harness, 23)
    arrived: list[int] = []
    seen = walk(harness, "limit=5", between=lambda: arrived.extend(add_jobs(harness, 2)))
    assert seen == sorted(original, reverse=True)
    assert len(arrived) == 8
    fresh = page(harness, "limit=5")
    assert ids(fresh) == sorted(arrived, reverse=True)[:5]
    assert fresh["total"] == 31


def test_oldest_order_pages_forwards(harness: Harness) -> None:
    original = add_jobs(harness, 7)
    assert walk(harness, "limit=3&order=oldest") == original


def test_limit_defaults_to_50_and_caps_at_200(harness: Harness) -> None:
    add_jobs(harness, 210)
    first = page(harness)
    assert len(first["items"]) == 50 and first["next_cursor"] is not None and first["total"] == 210
    assert len(page(harness, "limit=500")["items"]) == 200
    assert len(page(harness, "limit=0")["items"]) == 1
    last = page(harness, "limit=200&cursor=" + first["next_cursor"])
    assert len(last["items"]) == 160 and last["next_cursor"] is None


def test_bad_cursor_is_rejected(harness: Harness) -> None:
    assert harness.client.get("/api/jobs?cursor=abc").status_code == 422
    assert harness.client.get("/api/jobs?cursor=-1").status_code == 422


def test_filters_by_model_kind_status_and_ids(harness: Harness) -> None:
    alpha = model_id(harness, "Alpha")
    beta = model_id(harness, "Beta")
    gamma = model_id(harness, "Gamma")
    alpha_train = add_jobs(harness, 3, JobKind.TRAIN, alpha)
    beta_eval = add_jobs(harness, 2, JobKind.EVAL, beta, JobStatus.FAILED)
    gamma_train = add_jobs(harness, 2, JobKind.TRAIN, gamma, JobStatus.SUCCEEDED)
    add_jobs(harness, 4, JobKind.DOWNLOAD)
    both = page(harness, "model=alpha&model=beta")
    assert sorted(ids(both)) == sorted(alpha_train + beta_eval) and both["total"] == 5
    assert sorted(ids(page(harness, "kind=train&kind=eval"))) == sorted(alpha_train + beta_eval + gamma_train)
    assert sorted(ids(page(harness, "status=failed&status=succeeded"))) == sorted(beta_eval + gamma_train)
    assert ids(page(harness, "kind=train&status=failed")) == []
    assert ids(page(harness, "model=nobody")) == []
    wanted = [alpha_train[0], gamma_train[1]]
    assert sorted(ids(page(harness, f"id={wanted[0]}&id={wanted[1]}"))) == wanted


def test_search_matches_job_id_and_model_name(harness: Harness) -> None:
    alpha = model_id(harness, "Support triage")
    beta = model_id(harness, "Contract review")
    triage = add_jobs(harness, 2, JobKind.TRAIN, alpha)
    review = add_jobs(harness, 1, JobKind.EVAL, beta)
    assert sorted(ids(page(harness, "q=TRIAGE"))) == triage
    assert ids(page(harness, "q=contract-rev")) == review
    assert ids(page(harness, f"q=%23{review[0]}")) == review
    assert ids(page(harness, f"q={triage[1]}")) == [triage[1]]
    assert ids(page(harness, "q=%25")) == []


def test_date_range_filters_on_creation_time(harness: Harness) -> None:
    jobs = add_jobs(harness, 3)
    moment = now()
    with harness.sessions() as session:
        for days, job_id in zip((10, 3, 0), jobs, strict=True):
            job = session.get(Job, job_id)
            assert job is not None
            job.created_at = moment - timedelta(days=days)
        session.commit()
    since = (moment - timedelta(days=5)).isoformat().replace("+00:00", "Z")
    until = (moment - timedelta(days=1)).isoformat().replace("+00:00", "Z")
    assert ids(page(harness, f"since={since}")) == [jobs[2], jobs[1]]
    assert ids(page(harness, f"until={until}")) == [jobs[1], jobs[0]]
    assert ids(page(harness, f"since={since}&until={until}")) == [jobs[1]]


def test_facets_count_each_filter_without_itself(harness: Harness) -> None:
    alpha = model_id(harness, "Alpha")
    beta = model_id(harness, "Beta")
    add_jobs(harness, 3, JobKind.TRAIN, alpha)
    add_jobs(harness, 2, JobKind.EVAL, alpha, JobStatus.FAILED)
    add_jobs(harness, 4, JobKind.TRAIN, beta, JobStatus.SUCCEEDED)
    add_jobs(harness, 5, JobKind.DOWNLOAD)
    facets = harness.client.get("/api/jobs/facets?kind=train&kind=eval&model=alpha&status=failed").json()
    assert facets["total"] == 2
    assert facets["statuses"] == {"queued": 3, "failed": 2}
    assert facets["models"] == {"alpha": 2}
    everything = harness.client.get("/api/jobs/facets?kind=train&kind=eval").json()
    assert everything["models"] == {"alpha": 5, "beta": 4}
    assert everything["statuses"] == {"queued": 3, "failed": 2, "succeeded": 4}
