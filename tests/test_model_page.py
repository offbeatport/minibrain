from datetime import timedelta
from pathlib import Path
from typing import Any

from minibrain.registry.models import now
from minibrain.registry.service import address_taken
from tests.conftest import Harness
from tests.test_flow import SLUG, add_version, create_model, create_with_dataset, deploy, finish
from tests.test_gateway import servable
from tests.test_models import FILES
from tests.test_request_logs import seed
from tests.test_teardown import add_base


def page(harness: Harness, name: str = SLUG) -> dict[str, Any]:
    response = harness.client.get(f"/api/models/{name}/overview")
    assert response.status_code == 200, response.text
    return response.json()


def import_base(harness: Harness, tmp_path: Path, name: str) -> Any:
    folder = tmp_path / name.replace(" ", "-")
    folder.mkdir()
    for path, data in FILES.items():
        (folder / path).write_bytes(data)
    return harness.client.post("/api/models/import", json={"name": name, "location": str(folder)})


def test_names_are_unique_across_base_and_custom(harness: Harness, tmp_path: Path) -> None:
    create_model(harness)
    clash = import_base(harness, tmp_path, "Support Triage")
    assert clash.status_code == 409 and "Support Triage already exists" in clash.json()["detail"]
    assert import_base(harness, tmp_path, "Corp LLM").json()["key"] == "corp-llm"
    taken = harness.client.post("/api/models", json={"name": "Corp LLM", "preset": "general"})
    assert taken.status_code == 409
    renamed = harness.client.patch(f"/api/models/{SLUG}", json={"name": "corp llm"})
    assert renamed.status_code == 409 and "share names" in renamed.json()["detail"]
    base = harness.client.patch("/api/models/corp-llm", json={"name": "Support Triage"})
    assert base.status_code == 409
    assert harness.client.patch(f"/api/models/{SLUG}", json={"name": "SUPPORT triage"}).status_code == 200
    reserved = harness.client.post("/api/models", json={"name": "New", "preset": "general"})
    assert reserved.status_code == 201 and reserved.json()["slug"] == "new-2"
    held = harness.client.post("/api/models", json={"name": "Corp-LLM!", "preset": "general"})
    assert held.status_code == 201 and held.json()["slug"] == "corp-llm-2"
    with harness.sessions() as session:
        assert address_taken(session, SLUG) and address_taken(session, "corp-llm") and address_taken(session, "base")
        assert not address_taken(session, "free-name")


def test_a_name_finds_either_kind_of_model(harness: Harness) -> None:
    create_model(harness)
    add_base(harness, "tiny")
    assert (page(harness)["kind"], page(harness, "tiny")["kind"]) == ("custom", "base")
    assert harness.client.get("/api/models/nothing/overview").status_code == 404


def test_the_next_step_follows_the_model(harness: Harness) -> None:
    create_with_dataset(harness)
    assert page(harness)["next"] == {"kind": "train", "label": "Train v1", "version": 1, "count": None, "base": None}
    deploy(harness)
    assert page(harness)["next"] == {"kind": "train", "label": "Train v1", "version": 1, "count": None, "base": None}
    add_version(harness, "prompt")
    assert page(harness)["next"] is None
    finish(harness, "eval", accuracy=1.0)
    assert page(harness)["next"]["label"] == "v1 beats live, deploy it"
    harness.client.post(f"/api/models/{SLUG}/versions/1/promote")
    body = {"input": "I was charged twice", "output": "billing", "rating": "down", "correction": "account"}
    assert harness.client.post(f"/api/models/{SLUG}/feedback", json=body).status_code == 201
    assert page(harness)["next"] == {
        "kind": "review_feedback",
        "label": "1 feedback row to review",
        "version": None,
        "count": 1,
        "base": None,
    }


def test_a_base_is_deployed_then_built_on(harness: Harness) -> None:
    add_base(harness, "tiny")
    assert page(harness, "tiny")["next"]["kind"] == "deploy"
    assert harness.client.post("/api/models/tiny/deploy", json={"deployed": True}).status_code == 200
    assert page(harness, "tiny")["next"] == {
        "kind": "create_custom",
        "label": "Create a custom model from it",
        "version": None,
        "count": None,
        "base": None,
    }


def test_traffic_counts_requests_per_day_for_a_week(harness: Harness) -> None:
    servable(harness)
    moment = now()
    today = moment.replace(hour=0, minute=0, second=0, microsecond=0)
    seed(
        harness,
        {"at": moment - timedelta(seconds=5), "latency_ms": 10.0},
        {"at": moment - timedelta(seconds=4), "latency_ms": 20.0},
        {"at": moment - timedelta(seconds=3), "latency_ms": 900.0, "status": 500},
        {"at": today - timedelta(days=2) + timedelta(hours=1)},
        {"at": today - timedelta(days=2) + timedelta(hours=2)},
        {"at": today - timedelta(days=10)},
        {"at": moment - timedelta(seconds=2), "model_id": None, "model": "tiny", "version": None},
    )
    traffic = page(harness)["traffic"]
    assert [day["requests"] for day in traffic["days"]] == [0, 0, 0, 0, 2, 0, 3]
    assert traffic["days"][-1]["errors"] == 1
    assert (traffic["requests"], traffic["errors"], traffic["error_rate"]) == (5, 1, 0.2)
    assert traffic["p95_ms"] == 900.0
