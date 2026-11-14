from datetime import timedelta

import pytest
from sqlalchemy import event

from minibrain.api.model_rows import usage_index
from minibrain.models.hardware import GIB
from minibrain.registry.models import BaseModel, BaseModelStatus, Model, RequestLog, now
from minibrain.storage import Space
from tests.conftest import Harness, blank_dataset, give_data
from tests.test_flow import (
    SLUG,
    add_key,
    add_version,
    create_on_data,
    create_with_dataset,
    deploy,
    finish,
)


def custom_row(harness: Harness, slug: str) -> dict:
    return next(row for row in harness.client.get("/api/models").json() if row["key"] == slug)


def test_a_deployed_version_shows_its_score(harness: Harness) -> None:
    harness.client.post(
        "/api/models",
        json={
            "dataset": blank_dataset(harness.client),
            "preset": "classify",
            "labels": ["billing", "bug"],
            "name": "Support Triage",
        },
    )
    give_data(harness, SLUG)
    add_version(harness, "prompt")
    finish(harness, "eval", accuracy=0.8)
    deploy(harness, 1)
    row = custom_row(harness, SLUG)
    assert (row["score"], row["metric"]) == (0.8, "label_accuracy")


def test_usage_reports_total_trend_failures_and_last_use(harness: Harness) -> None:
    harness.client.post(
        "/api/models",
        json={
            "dataset": blank_dataset(harness.client),
            "preset": "classify",
            "labels": ["billing", "bug"],
            "name": "Support Triage",
        },
    )
    assert custom_row(harness, SLUG)["usage"] is None
    with harness.sessions() as session:
        model = session.query(Model).filter_by(slug=SLUG).one()
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
            session.add(RequestLog(at=moment, model_id=model.id, model=SLUG, status=status, latency_ms=latency))
        session.commit()
    usage = custom_row(harness, SLUG)["usage"]
    assert (usage["total"], usage["previous"], usage["failed"]) == (3, 1, 1)
    assert len(usage["daily"]) == 7 and usage["daily"][-1] == 2 and usage["daily"][-3] == 1
    assert usage["p50_ms"] == 20.0
    assert usage["last_at"].startswith(now().date().isoformat())


def test_last_use_is_reported_even_without_recent_requests(harness: Harness) -> None:
    harness.client.post(
        "/api/models",
        json={
            "dataset": blank_dataset(harness.client),
            "preset": "classify",
            "labels": ["billing", "bug"],
            "name": "Support Triage",
        },
    )
    with harness.sessions() as session:
        model = session.query(Model).filter_by(slug=SLUG).one()
        moment = now() - timedelta(days=12)
        session.add(RequestLog(at=moment, model_id=model.id, model=SLUG, status=200, latency_ms=5.0))
        session.commit()
    usage = custom_row(harness, SLUG)["usage"]
    assert (usage["total"], usage["previous"], usage["p50_ms"]) == (0, 1, None)


def test_demo_creates_a_model_with_mapped_data_each_time(harness: Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("minibrain.api.catalog.cached_fully", lambda _variant: True)
    monkeypatch.setattr("minibrain.storage.disk_space", lambda _path: Space(free=100 * GIB, total=200 * GIB))
    first = harness.client.post("/api/models/demo")
    assert first.status_code == 201, first.text
    body = first.json()
    assert (body["name"], body["preset"], body["source"]["file"]) == (
        "Demo travel intents",
        "general",
        "demo_travel_intents.jsonl",
    )
    assert body["mapping"]["template"] == {"user": "{message}", "assistant": "{intent}"}
    assert body["dataset_version"]["rows"] == 750
    assert len(body["label_proposal"]["labels"]) == 5
    again = harness.client.post("/api/models/demo").json()
    assert (again["name"], again["dataset"]) == ("Demo travel intents 2", body["dataset"])


def test_each_version_is_reported_with_its_own_status_and_requests(harness: Harness) -> None:
    create_on_data(harness)
    finish(harness, "eval", accuracy=0.8)
    deploy(harness)
    add_version(harness, "lora")
    with harness.sessions() as session:
        model = session.query(Model).filter_by(slug=SLUG).one()
        for _ in range(3):
            session.add(RequestLog(at=now(), model_id=model.id, model=SLUG, version=0, status=200, latency_ms=9.0))
        session.commit()
    versions = {item["number"]: item for item in custom_row(harness, SLUG)["versions"]}
    assert (versions[0]["live"], versions[0]["score"], versions[0]["usage"]["total"]) == (True, 0.8, 3)
    assert versions[0]["promotion"]["passed"] is True
    assert (versions[1]["live"], versions[1]["status"], versions[1]["usage"]) == (False, "training", None)


def test_v0_cannot_be_deleted(harness: Harness) -> None:
    create_on_data(harness)
    finish(harness, "eval", accuracy=0.8)
    refused = harness.client.delete(f"/api/models/{SLUG}/versions/0")
    assert refused.status_code == 409 and "baseline" in refused.json()["detail"]
    assert [item["number"] for item in custom_row(harness, SLUG)["versions"]] == [0]


def test_a_deployed_version_must_be_undeployed_before_it_is_deleted(harness: Harness) -> None:
    create_on_data(harness)
    finish(harness, "eval", accuracy=0.8)
    assert add_version(harness, "prompt")["number"] == 1
    finish(harness, "eval", accuracy=0.9)
    deploy(harness, 1)
    refused = harness.client.delete(f"/api/models/{SLUG}/versions/1")
    assert refused.status_code == 409 and "undeploy it first" in refused.json()["detail"]
    harness.client.post(f"/api/models/{SLUG}/deploy", json={"deployed": False})
    assert harness.client.delete(f"/api/models/{SLUG}/versions/1").status_code == 204
    assert [item["number"] for item in custom_row(harness, SLUG)["versions"]] == [0]


def test_rows_count_api_keys(harness: Harness) -> None:
    harness.client.post(
        "/api/models",
        json={
            "dataset": blank_dataset(harness.client),
            "preset": "classify",
            "labels": ["billing", "bug"],
            "name": "Support Triage",
        },
    )
    add_key(harness, name="app")
    add_key(harness, name="batch")
    assert custom_row(harness, SLUG)["key_count"] == 2


def test_a_deployed_model_must_be_undeployed_before_it_is_deleted(harness: Harness) -> None:
    create_with_dataset(harness)
    harness.client.post(f"/api/models/{SLUG}/deploy", json={"deployed": True})
    refused = harness.client.delete(f"/api/models/{SLUG}")
    assert refused.status_code == 409 and "undeploy it first" in refused.json()["detail"]
    harness.client.post(f"/api/models/{SLUG}/deploy", json={"deployed": False})
    assert harness.client.delete(f"/api/models/{SLUG}").status_code == 202


def test_new_models_take_a_ready_preset(harness: Harness) -> None:
    later = harness.client.post(
        "/api/models", json={"dataset": blank_dataset(harness.client), "name": "Fields", "preset": "extract"}
    )
    assert later.status_code == 422
    created = harness.client.post(
        "/api/models", json={"dataset": blank_dataset(harness.client), "name": "Notes", "preset": "custom"}
    )
    assert created.status_code == 201
    assert (created.json()["preset"], created.json()["contract"]["kind"]) == ("custom", "text")


def test_a_base_model_counts_only_requests_made_since_it_was_added(harness: Harness) -> None:
    with harness.sessions() as session:
        session.add(RequestLog(at=now() - timedelta(days=2), model="tiny", status=200, latency_ms=5.0))
        session.add(BaseModel(id="tiny", source="download", name="Tiny", status=BaseModelStatus.AVAILABLE))
        session.commit()
        session.add(RequestLog(at=now(), model="tiny", status=200, latency_ms=5.0))
        session.commit()
        assert usage_index(session).base["tiny"].total == 1


def count_queries(harness: Harness) -> int:
    engine = harness.sessions.kw["bind"]
    seen: list[object] = []

    def record(*args: object) -> None:
        seen.append(args[2])

    event.listen(engine, "before_cursor_execute", record)
    try:
        assert harness.client.get("/api/models").status_code == 200
    finally:
        event.remove(engine, "before_cursor_execute", record)
    return len(seen)


def scored_model(harness: Harness, name: str) -> None:
    created = create_on_data(harness, name)
    finish(harness, "eval", accuracy=0.7)
    with harness.sessions() as session:
        model = session.query(Model).filter_by(slug=created["slug"]).one()
        for version in (0, None):
            session.add(
                RequestLog(at=now(), model_id=model.id, model=model.slug, version=version, status=200, latency_ms=9.0)
            )
        session.commit()


def test_listing_takes_the_same_queries_however_many_models_and_versions_there_are(harness: Harness) -> None:
    scored_model(harness, "First")
    one = count_queries(harness)
    for name in ("Second", "Third", "Fourth"):
        scored_model(harness, name)
    rows = [row for row in harness.client.get("/api/models").json() if row["kind"] == "custom"]
    assert len(rows) == 4 and all(row["versions"][0]["score"] == 0.7 for row in rows)
    assert count_queries(harness) == one


def test_usage_reports_p95_and_errors_from_one_pass(harness: Harness) -> None:
    harness.client.post(
        "/api/models",
        json={
            "dataset": blank_dataset(harness.client),
            "preset": "classify",
            "labels": ["billing", "bug"],
            "name": "Support Triage",
        },
    )
    with harness.sessions() as session:
        model = session.query(Model).filter_by(slug=SLUG).one()
        for index in range(20):
            status = 429 if index == 0 else 500 if index == 1 else 200
            latency = float(index + 1) * 10
            session.add(RequestLog(at=now(), model_id=model.id, model=SLUG, status=status, latency_ms=latency))
        session.commit()
    usage = custom_row(harness, SLUG)["usage"]
    assert (usage["total"], usage["errors"], usage["failed"]) == (20, 2, 1)
    assert (usage["p50_ms"], usage["p95_ms"], usage["device_seconds"]) == (100.0, 190.0, 2.1)
    week = harness.client.get(f"/api/models/{SLUG}/traffic", params={"range": "7d"}).json()["totals"]
    listed = (usage["total"], usage["errors"], usage["p95_ms"], usage["device_seconds"])
    assert listed == (week["requests"], week["errors"], week["p95_ms"], week["device_seconds"])


def announce(harness: Harness, number: int, base: str) -> None:
    body = {
        "id": f"e-{number}",
        "host": f"gpu-{number}",
        "url": f"http://gpu-{number}:9000",
        "base_model": base,
        "engine": "sglang",
        "state": "ready",
        "pool": "rack",
    }
    response = harness.client.post("/internal/gateway/engines", json=body, headers=harness.gateway_headers)
    assert response.status_code == 204


def test_a_deployed_model_lists_the_engines_serving_it_in_its_pool(harness: Harness) -> None:
    create_on_data(harness)
    finish(harness, "eval", accuracy=0.8)
    base = custom_row(harness, SLUG)["base_model"]
    announce(harness, 1, base)
    announce(harness, 2, base)
    assert custom_row(harness, SLUG)["replicas"] == []
    deploy(harness)
    assert custom_row(harness, SLUG)["replicas"] == []
    promoted = harness.client.post(f"/api/models/{SLUG}/versions/0/promote", json={"pool": "rack"})
    assert promoted.status_code == 200, promoted.text
    replicas = custom_row(harness, SLUG)["replicas"]
    assert [(item["host"], item["pool"], item["state"]) for item in replicas] == [
        ("gpu-1", "rack", "ready"),
        ("gpu-2", "rack", "ready"),
    ]


def add_variant(harness: Harness, key: str, variant: str, name: str) -> None:
    with harness.sessions() as session:
        session.add(
            BaseModel(
                id=key,
                source="download",
                name=name,
                catalog_id="qwen3-0.6b",
                variant_id=variant,
                status=BaseModelStatus.AVAILABLE,
            )
        )
        session.commit()


def test_base_variants_name_their_catalogue_model_format_and_whether_they_train(harness: Harness) -> None:
    add_variant(harness, "qwen3-0.6b", "qwen3-0.6b:bf16:safetensors", "Qwen3 0.6B")
    add_variant(harness, "qwen3-0.6b-q8_0-gguf", "qwen3-0.6b:q8_0:gguf", "Qwen3 0.6B Q8_0")
    rows = {row["key"]: row for row in harness.client.get("/api/models").json() if row["kind"] == "base"}
    full, gguf = rows["qwen3-0.6b"], rows["qwen3-0.6b-q8_0-gguf"]
    assert (full["catalog_name"], full["variant_label"], full["serve_only"]) == ("Qwen3 0.6B", "BF16", None)
    assert (gguf["catalog_name"], gguf["variant_label"]) == ("Qwen3 0.6B", "GGUF Q8_0")
    assert gguf["serve_only"]["format"] == "GGUF" and gguf["serve_only"]["switch_to"]["key"] == "qwen3-0.6b"
