from datetime import timedelta

from minibrain.registry.models import Minibrain, RequestLog, now
from tests.conftest import Harness
from tests.test_flow import SLUG, add_version, create_with_dataset, finish


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
    row = custom_row(harness, SLUG)
    assert [stage["state"] for stage in row["stages"]] == ["done", "done", "done", "done"]
    assert [stage["label"] for stage in row["stages"]][1:] == ["v0", "80% on v0", "v0 live"]
    assert row["stages"][0]["label"].endswith(" examples")
    assert row["accuracy"] == 0.8
    add_version(harness, "lora")
    assert custom_row(harness, SLUG)["stages"][1]["state"] == "active"


def test_usage_counts_the_last_seven_days_and_the_median_latency(harness: Harness) -> None:
    harness.client.post("/api/minibrains", json={"name": "Support Triage"})
    assert custom_row(harness, SLUG)["usage"] is None
    with harness.sessions() as session:
        minibrain = session.query(Minibrain).filter_by(slug=SLUG).one()
        moments = [now(), now(), now() - timedelta(days=2), now() - timedelta(days=30)]
        for moment, latency in zip(moments, [10.0, 30.0, 20.0, 999.0], strict=True):
            session.add(RequestLog(at=moment, minibrain_id=minibrain.id, model=SLUG, status=200, latency_ms=latency))
        session.commit()
    usage = custom_row(harness, SLUG)["usage"]
    assert len(usage["daily"]) == 7 and usage["daily"][-1] == 2 and usage["daily"][-3] == 1 and sum(usage["daily"]) == 3
    assert usage["p50_ms"] == 20.0
    assert len(usage["days"]) == 7 and usage["days"][-1] == now().date().isoformat()


def test_sample_creates_a_model_with_mapped_data_each_time(harness: Harness) -> None:
    first = harness.client.post("/api/minibrains/sample")
    assert first.status_code == 201, first.text
    body = first.json()
    assert (body["name"], body["source"]["file"]) == ("Travel intents (sample)", "travel_intents.jsonl")
    assert (body["mapping"]["input_column"], body["mapping"]["label_column"]) == ("message", "intent")
    assert body["source"]["rows"] > 100
    assert harness.client.post("/api/minibrains/sample").json()["name"] == "Travel intents (sample) 2"
