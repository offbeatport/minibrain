from pathlib import Path

from minibrain.registry.models import ApiKey, AuditEvent
from tests.conftest import Harness
from tests.test_flow import SLUG, add_key, create_on_data, create_with_dataset, deploy, finish
from tests.test_models import FILES

CUSTOM = ("custom", SLUG)
BASE = ("base", "base-one")


def chat(model: str) -> dict:
    return {"model": model, "messages": [{"role": "user", "content": "I was charged twice"}]}


def two_models(harness: Harness, tmp_path: Path) -> None:
    folder = tmp_path / "base"
    folder.mkdir()
    for name, data in FILES.items():
        (folder / name).write_bytes(data)
    harness.client.post(
        "/api/base-models/import", json={"name": "Base One", "source_type": "folder", "location": str(folder)}
    )
    harness.worker(kinds=["import"]).run_once()
    assert harness.client.post("/api/base-models/base-one/deploy", json={"deployed": True}).status_code == 200
    create_on_data(harness)
    finish(harness, "eval", accuracy=0.4)
    deploy(harness)


def headers(created: dict) -> dict[str, str]:
    return {"Authorization": f"Bearer {created['secret']}"}


def test_one_key_covers_several_models(harness: Harness, tmp_path: Path) -> None:
    two_models(harness, tmp_path)
    both = headers(add_key(harness, CUSTOM, BASE))
    names = [model["id"] for model in harness.client.get("/v1/models", headers=both).json()["data"]]
    assert set(names) == {SLUG, f"{SLUG}@0", "base-one"}
    for model in (SLUG, "base-one"):
        assert harness.client.post("/v1/chat/completions", headers=both, json=chat(model)).status_code == 200
    narrow = headers(add_key(harness, BASE))
    refused = harness.client.post("/v1/chat/completions", headers=narrow, json=chat(SLUG))
    assert refused.status_code == 403 and SLUG in refused.json()["detail"]
    missing = harness.client.post("/v1/chat/completions", headers=narrow, json=chat("nope"))
    assert missing.status_code == 404


def test_scopes_change_and_keys_revoke(harness: Harness, tmp_path: Path) -> None:
    two_models(harness, tmp_path)
    created = add_key(harness, BASE)
    assert [model["key"] for model in created["models"]] == ["base-one"]
    body = {"models": [{"kind": "custom", "key": SLUG}]}
    updated = harness.client.put(f"/api/keys/{created['id']}/models", json=body).json()
    assert [(model["kind"], model["name"]) for model in updated["models"]] == [("custom", "Support Triage")]
    auth = headers(created)
    assert harness.client.post("/v1/chat/completions", headers=auth, json=chat(SLUG)).status_code == 200
    assert harness.client.post("/v1/chat/completions", headers=auth, json=chat("base-one")).status_code == 403
    assert harness.client.put(f"/api/keys/{created['id']}/models", json={"models": []}).status_code == 422
    assert harness.client.delete(f"/api/keys/{created['id']}").status_code == 204
    assert harness.client.post("/v1/chat/completions", headers=auth, json=chat(SLUG)).status_code == 401
    with harness.sessions() as session:
        actions = [event.action for event in session.query(AuditEvent).order_by(AuditEvent.id)]
    assert [action for action in actions if action.startswith("key.")] == ["key.create", "key.update", "key.revoke"]


def test_deleting_a_model_keeps_keys_that_cover_others(harness: Harness, tmp_path: Path) -> None:
    two_models(harness, tmp_path)
    add_key(harness, CUSTOM, name="only-custom")
    add_key(harness, CUSTOM, BASE, name="both")
    harness.client.post(f"/api/models/{SLUG}/deploy", json={"deployed": False})
    assert harness.client.delete(f"/api/models/{SLUG}").status_code == 202
    harness.settle()
    keys = harness.client.get("/api/keys").json()
    assert [(key["name"], [model["key"] for model in key["models"]]) for key in keys] == [("both", ["base-one"])]
    with harness.sessions() as session:
        assert session.query(ApiKey).count() == 1


def test_keys_need_a_known_model(harness: Harness) -> None:
    create_with_dataset(harness)
    unknown = {"name": "x", "models": [{"kind": "base", "key": "nope"}]}
    assert harness.client.post("/api/keys", json=unknown).status_code == 404
    assert harness.client.post("/api/keys", json={"name": "x", "models": []}).status_code == 422


def test_keys_need_a_name_unique_per_model(harness: Harness, tmp_path: Path) -> None:
    two_models(harness, tmp_path)
    custom = [{"kind": "custom", "key": SLUG}]
    assert harness.client.post("/api/keys", json={"models": custom}).status_code == 422
    assert harness.client.post("/api/keys", json={"name": "   ", "models": custom}).status_code == 422
    assert harness.client.post("/api/keys", json={"name": "x" * 61, "models": custom}).status_code == 422
    first = harness.client.post("/api/keys", json={"name": " helpdesk ", "models": custom})
    assert first.status_code == 201 and first.json()["name"] == "helpdesk"
    clash = harness.client.post("/api/keys", json={"name": "HelpDesk", "models": custom})
    assert clash.status_code == 409
    assert clash.json()["detail"] == "A key called HelpDesk already calls Support Triage."
    base = [{"kind": "base", "key": "base-one"}]
    assert harness.client.post("/api/keys", json={"name": "helpdesk", "models": base}).status_code == 201
    both = harness.client.post("/api/keys", json={"name": "helpdesk", "models": custom + base})
    assert both.status_code == 409
