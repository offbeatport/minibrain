import hashlib
from typing import Any

import pytest

from minibrain.auth.roles import Role
from minibrain.registry.models import BaseModel, BaseModelStatus
from tests.conftest import LABELS, Harness, blank_dataset, give_data
from tests.test_flow import SLUG, add_version, bearer, build_dataset, deploy, finish
from tests.test_model_page import page
from tests.test_teardown import BASE, add_base, events, shown, trained_and_live

pytestmark = pytest.mark.both_stores

GGUF = "qwen3-0.6b-q8_0-gguf"
FULL = "qwen3-0.6b"
REASON = "Qwen3 0.6B Q8_0 is GGUF, which serves only. Switch to Qwen3 0.6B BF16 to train."
CHAT = {"model": SLUG, "messages": [{"role": "user", "content": "I was charged twice"}]}


def add_gguf(harness: Harness) -> None:
    folder = harness.settings.home / "models" / GGUF
    folder.mkdir(parents=True)
    data = b"GGUF" + b"\0" * 64
    (folder / "model.gguf").write_bytes(data)
    with harness.sessions() as session:
        session.add(
            BaseModel(
                id=GGUF,
                source="download",
                name="Qwen3 0.6B Q8_0",
                catalog_id=FULL,
                variant_id="qwen3-0.6b:q8_0:gguf",
                files=[{"path": "model.gguf", "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}],
                size_bytes=len(data),
                status=BaseModelStatus.AVAILABLE,
                repo="Qwen/Qwen3-0.6B-GGUF",
                revision="b" * 40,
            )
        )
        session.commit()


def on_gguf(harness: Harness) -> None:
    add_gguf(harness)
    body = {"name": "Support Triage", "preset": "classify", "labels": list(LABELS), "base_model": GGUF}
    created = harness.client.post("/api/models", json={"dataset": blank_dataset(harness.client)} | body)
    assert created.status_code == 201, created.text
    give_data(harness, SLUG)
    build_dataset(harness)


def switch(harness: Harness, base: str, client: Any = None) -> Any:
    return (client or harness.client).post(f"/api/models/{SLUG}/base", json={"base_model": base})


def versions(harness: Harness) -> dict[int, dict[str, Any]]:
    return {item["number"]: item for item in harness.client.get(f"/api/models/{SLUG}/versions").json()}


def routes(harness: Harness) -> dict[str, Any]:
    response = harness.client.get("/internal/gateway/config", headers=harness.gateway_headers)
    return response.json()["routes"]


def test_a_serve_only_model_offers_the_switch_and_refuses_training(harness: Harness) -> None:
    on_gguf(harness)
    deploy(harness, max(versions(harness)))
    assert page(harness)["next"] == {
        "kind": "switch_base",
        "label": "Move to Qwen3 0.6B BF16 to train",
        "version": None,
        "count": None,
        "base": FULL,
    }
    refused = harness.client.post(f"/api/models/{SLUG}/versions", json={"kind": "lora", "max_rows": 100})
    assert refused.status_code == 409 and refused.json()["detail"] == REASON
    limit = shown(harness, SLUG)["serve_only"]
    assert (limit["format"], limit["reason"]) == ("GGUF", REASON)
    assert limit["switch_to"] == {
        "key": FULL,
        "name": "Qwen3 0.6B BF16",
        "catalog_id": FULL,
        "variant_id": "qwen3-0.6b:bf16:safetensors",
        "size_bytes": limit["switch_to"]["size_bytes"],
        "installed": True,
    }
    options = harness.client.get(f"/api/models/{SLUG}/base-options").json()
    assert options["current"] == GGUF and options["switch_to"]["key"] == FULL
    choices = {item["key"]: item for item in options["choices"]}
    assert choices[GGUF]["current"] and choices[GGUF]["serve_only"] == "GGUF"
    assert not choices[FULL]["current"] and choices[FULL]["serve_only"] is None and choices[FULL]["refusal"] is None


def test_switching_keeps_settings_and_data_and_scores_a_new_version(harness: Harness) -> None:
    on_gguf(harness)
    harness.client.put(f"/api/models/{SLUG}/instructions", json={"instructions": "Name the owning team."})
    harness.client.patch(f"/api/models/{SLUG}", json={"description": "Routes tickets", "tags": ["support"]})
    feedback = {"input": "I was charged twice", "output": "bug", "rating": "down", "correction": "billing"}
    assert harness.client.post(f"/api/models/{SLUG}/feedback", json=feedback).status_code == 201
    headers = bearer(harness)
    before = harness.client.get(f"/api/models/{SLUG}").json()
    newest = max(versions(harness))
    switched = switch(harness, FULL)
    assert switched.status_code == 200, switched.text
    after = switched.json()
    assert after["base_model"] == FULL and after["slug"] == SLUG and after["name"] == "Support Triage"
    for field in ("preset", "contract", "instructions", "promotion", "graders", "dataset"):
        assert after[field] == before[field], field
    found = versions(harness)
    fresh = found[newest + 1]
    assert (fresh["kind"], fresh["status"], fresh["base_model"]) == ("prompt", "evaluating", FULL)
    assert fresh["instructions"] == "Name the owning team."
    finish(harness, "eval", accuracy=0.8)
    assert versions(harness)[newest + 1]["score"] is not None
    old = versions(harness)[newest]
    assert old["base_model"] == GGUF
    assert old["base_refusal"] == (
        f"v{newest} was made on Qwen3 0.6B Q8_0, and Support Triage is on Qwen3 0.6B now. "
        "Only versions made on Qwen3 0.6B can be deployed; score or train one there."
    )
    queue = harness.client.get(f"/api/feedback?model={SLUG}").json()
    assert queue["total"] == 1
    keys = harness.client.get("/api/keys").json()
    assert [model["key"] for model in keys[0]["models"]] == [SLUG]
    assert harness.client.post("/v1/chat/completions", headers=headers, json=CHAT).status_code == 404
    row = shown(harness, SLUG)
    assert row["serve_only"] is None and row["base_model"] == FULL
    assert {item["number"]: item["base_model"] for item in row["versions"]}[newest] == GGUF
    [event] = events(harness, "model.base_change")
    assert event.target == SLUG
    assert (event.detail["from"], event.detail["to"], event.detail["version"]) == (GGUF, FULL, newest + 1)


def test_the_live_version_keeps_serving_on_its_own_base(harness: Harness) -> None:
    trained_and_live(harness)
    add_base(harness)
    headers = bearer(harness)
    assert switch(harness, BASE).status_code == 200
    served = routes(harness)
    assert served[SLUG]["base_model"] == FULL and served[SLUG]["version"] == 1
    assert served[SLUG]["adapter"]["name"] == f"{SLUG}-v1"
    newest = max(versions(harness))
    assert f"{SLUG}@{newest}" not in served
    reply = harness.client.post("/v1/chat/completions", headers=headers, json=CHAT)
    assert reply.status_code == 200, reply.text
    request = harness.backend.requests[-1]
    assert request.base.key == FULL and request.adapter is not None
    assert harness.client.post(f"/api/models/{SLUG}/versions/1/promote").status_code == 200
    finish(harness, "eval", accuracy=0.95)
    assert routes(harness)[f"{SLUG}@{newest}"]["base_model"] == BASE
    assert routes(harness)[SLUG]["base_model"] == FULL
    deploy(harness, newest)
    assert routes(harness)[SLUG]["base_model"] == BASE
    assert page(harness)["next"]["kind"] != "promote"


def test_deploying_a_version_from_another_base_is_refused(harness: Harness) -> None:
    trained_and_live(harness)
    add_base(harness)
    assert switch(harness, BASE).status_code == 200
    finish(harness, "eval", accuracy=0.95)
    deploy(harness, max(versions(harness)))
    refused = harness.client.post(f"/api/models/{SLUG}/versions/1/promote")
    assert refused.status_code == 409
    assert "was made on" in refused.json()["detail"] and "can be deployed" in refused.json()["detail"]
    assert routes(harness)[SLUG]["base_model"] == BASE
    candidates = [item["ready_version"] for item in [shown(harness, SLUG)]]
    assert candidates == [None]


def test_a_deployed_model_with_nothing_live_keeps_serving_its_old_base(harness: Harness) -> None:
    on_gguf(harness)
    assert harness.client.post(f"/api/models/{SLUG}/deploy", json={"deployed": True}).status_code == 200
    assert routes(harness)[SLUG]["base_model"] == GGUF
    assert switch(harness, FULL).status_code == 200
    assert routes(harness)[SLUG]["base_model"] == GGUF
    harness.client.post(f"/api/models/{SLUG}/deploy", json={"deployed": False})
    harness.settle()
    assert harness.client.post(f"/api/models/{SLUG}/deploy", json={"deployed": True}).status_code == 200
    assert routes(harness)[SLUG]["base_model"] == FULL


def test_switching_is_refused_when_it_cannot_happen(harness: Harness) -> None:
    trained_and_live(harness)
    same = switch(harness, FULL)
    assert same.status_code == 409 and "already on" in same.json()["detail"]
    missing = switch(harness, "nope")
    assert missing.status_code == 409 and "not a base model on this install" in missing.json()["detail"]
    add_version(harness, "lora")
    add_base(harness)
    training = switch(harness, BASE)
    assert training.status_code == 409 and "still training" in training.json()["detail"]
    finish(harness, "train")
    finish(harness, "eval")
    assert harness.client.delete(f"/api/models/{SLUG}", params={"undeploy": True}).status_code == 202
    deleting = switch(harness, BASE)
    assert deleting.status_code == 409 and "being deleted" in deleting.json()["detail"]


def test_the_options_warn_about_what_the_new_base_lacks(harness: Harness) -> None:
    trained_and_live(harness)
    add_gguf(harness)
    choices = {item["key"]: item for item in harness.client.get(f"/api/models/{SLUG}/base-options").json()["choices"]}
    warnings = choices[GGUF]["warnings"]
    assert any("can't call tools" in item for item in warnings)
    assert any("doesn't reason" in item for item in warnings)
    assert choices[FULL]["warnings"] == []


def test_only_builders_switch_and_each_switch_is_audited(harness: Harness) -> None:
    on_gguf(harness)
    assert switch(harness, FULL, harness.person(Role.VIEWER)).status_code == 403
    assert harness.person(Role.VIEWER).get(f"/api/models/{SLUG}/base-options").status_code == 200
    assert switch(harness, FULL, harness.person(Role.BUILDER)).status_code == 200
    [event] = events(harness, "model.base_change")
    assert event.actor == "builder@example.com" and event.detail["from"] == GGUF
