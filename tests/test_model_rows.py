from datetime import timedelta

import pytest

from minibrain.api.model_rows import usage_index
from minibrain.models.hardware import GIB
from minibrain.registry.models import Minibrain, Model, ModelStatus, RequestLog, now
from minibrain.storage import Space
from tests.conftest import Harness
from tests.test_flow import SLUG, add_key, add_version, create_with_dataset, deploy, finish


def custom_row(harness: Harness, slug: str) -> dict:
    return next(row for row in harness.client.get("/api/models").json() if row["key"] == slug)


def test_stages_follow_the_model_from_data_to_deployment(harness: Harness) -> None:
    harness.client.post("/api/minibrains", json={"name": "Support Triage"})
    stages = custom_row(harness, SLUG)["stages"]
    assert [(stage["key"], stage["state"]) for stage in stages] == [
        ("data", "todo"),
        ("train", "todo"),
        ("evaluate", "todo"),
        ("deploy", "todo"),
    ]
    create_with_dataset(harness)
    add_version(harness, "prompt")
    finish(harness, "eval", accuracy=0.8)
    deploy(harness)
    row = custom_row(harness, SLUG)
    assert [stage["state"] for stage in row["stages"]] == ["done", "done", "done", "done"]
    assert [stage["label"] for stage in row["stages"]][1:] == ["v0", "80% on v0", "v0 live"]
    assert row["stages"][0]["label"].endswith(" examples")
    assert row["accuracy"] == 0.8
    add_version(harness, "lora")
    assert custom_row(harness, SLUG)["stages"][1]["state"] == "active"


def test_usage_reports_total_trend_failures_and_last_use(harness: Harness) -> None:
    harness.client.post("/api/minibrains", json={"name": "Support Triage"})
    assert custom_row(harness, SLUG)["usage"] is None
    with harness.sessions() as session:
        minibrain = session.query(Minibrain).filter_by(slug=SLUG).one()
        moment = now()
        earlier_today = moment - (moment - moment.replace(hour=0, minute=0, second=0, microsecond=0)) / 2
        requests = [
            (moment, 200, 10.0),
            (earlier_today, 500, 30.0),
            (now() - timedelta(days=2), 200, 20.0),
            (now() - timedelta(days=10), 200, 50.0),
            (now() - timedelta(days=30), 200, 999.0),
        ]
        for moment, status, latency in requests:
            session.add(RequestLog(at=moment, minibrain_id=minibrain.id, model=SLUG, status=status, latency_ms=latency))
        session.commit()
    usage = custom_row(harness, SLUG)["usage"]
    assert (usage["total"], usage["previous"], usage["failed"]) == (3, 1, 1)
    assert len(usage["daily"]) == 7 and usage["daily"][-1] == 2 and usage["daily"][-3] == 1
    assert usage["p50_ms"] == 20.0
    assert usage["last_at"].startswith(now().date().isoformat())


def test_last_use_is_reported_even_without_recent_requests(harness: Harness) -> None:
    harness.client.post("/api/minibrains", json={"name": "Support Triage"})
    with harness.sessions() as session:
        minibrain = session.query(Minibrain).filter_by(slug=SLUG).one()
        moment = now() - timedelta(days=12)
        session.add(RequestLog(at=moment, minibrain_id=minibrain.id, model=SLUG, status=200, latency_ms=5.0))
        session.commit()
    usage = custom_row(harness, SLUG)["usage"]
    assert (usage["total"], usage["previous"], usage["p50_ms"]) == (0, 1, None)


def test_sample_creates_a_model_with_mapped_data_each_time(harness: Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("minibrain.api.catalog.cached_fully", lambda _variant: True)
    monkeypatch.setattr("minibrain.storage.disk_space", lambda _path: Space(free=100 * GIB, total=200 * GIB))
    first = harness.client.post("/api/minibrains/sample")
    assert first.status_code == 201, first.text
    body = first.json()
    assert (body["name"], body["source"]["file"]) == ("Travel intents (sample)", "travel_intents.jsonl")
    assert (body["mapping"]["input_column"], body["mapping"]["label_column"]) == ("message", "intent")
    assert body["source"]["rows"] > 100
    assert harness.client.post("/api/minibrains/sample").json()["name"] == "Travel intents (sample) 2"


def test_each_version_is_reported_with_its_own_status_and_requests(harness: Harness) -> None:
    create_with_dataset(harness)
    add_version(harness, "prompt")
    finish(harness, "eval", accuracy=0.8)
    deploy(harness)
    add_version(harness, "lora")
    with harness.sessions() as session:
        minibrain = session.query(Minibrain).filter_by(slug=SLUG).one()
        for _ in range(3):
            session.add(
                RequestLog(at=now(), minibrain_id=minibrain.id, model=SLUG, version=0, status=200, latency_ms=9.0)
            )
        session.commit()
    versions = {item["number"]: item for item in custom_row(harness, SLUG)["versions"]}
    assert (versions[0]["live"], versions[0]["accuracy"], versions[0]["usage"]["total"]) == (True, 0.8, 3)
    assert (versions[1]["live"], versions[1]["status"], versions[1]["usage"]) == (False, "training", None)


def test_a_deployed_version_must_be_undeployed_before_it_is_deleted(harness: Harness) -> None:
    create_with_dataset(harness)
    add_version(harness, "prompt")
    finish(harness, "eval", accuracy=0.8)
    deploy(harness)
    refused = harness.client.delete(f"/api/minibrains/{SLUG}/versions/0")
    assert refused.status_code == 409 and "undeploy it first" in refused.json()["detail"]
    harness.client.post(f"/api/minibrains/{SLUG}/deploy", json={"deployed": False})
    assert harness.client.delete(f"/api/minibrains/{SLUG}/versions/0").status_code == 204
    assert custom_row(harness, SLUG)["versions"] == []
    assert add_version(harness, "prompt")["number"] == 1


def test_rows_count_api_keys(harness: Harness) -> None:
    harness.client.post("/api/minibrains", json={"name": "Support Triage"})
    add_key(harness, name="app")
    add_key(harness, name="batch")
    assert custom_row(harness, SLUG)["key_count"] == 2


def test_a_deployed_model_must_be_undeployed_before_it_is_deleted(harness: Harness) -> None:
    create_with_dataset(harness)
    harness.client.post(f"/api/minibrains/{SLUG}/deploy", json={"deployed": True})
    refused = harness.client.delete(f"/api/minibrains/{SLUG}")
    assert refused.status_code == 409 and "undeploy it first" in refused.json()["detail"]
    harness.client.post(f"/api/minibrains/{SLUG}/deploy", json={"deployed": False})
    assert harness.client.delete(f"/api/minibrains/{SLUG}").status_code == 202


def test_new_models_take_a_task_type_and_can_start_from_the_sample(harness: Harness) -> None:
    later = harness.client.post("/api/minibrains", json={"name": "Fields", "task": "extract"})
    assert later.status_code == 409 and "not available yet" in later.json()["detail"]
    created = harness.client.post("/api/minibrains", json={"name": "Trips", "sample": True})
    assert created.status_code == 201
    assert created.json()["dataset"] is not None and created.json()["source"]["rows"] > 0


def test_a_base_model_counts_only_requests_made_since_it_was_added(harness: Harness) -> None:
    with harness.sessions() as session:
        session.add(RequestLog(at=now() - timedelta(days=2), model="tiny", status=200, latency_ms=5.0))
        session.add(Model(id="tiny", source="download", name="Tiny", status=ModelStatus.AVAILABLE))
        session.commit()
        session.add(RequestLog(at=now(), model="tiny", status=200, latency_ms=5.0))
        session.commit()
        assert usage_index(session).base["tiny"].total == 1
