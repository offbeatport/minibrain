from datetime import datetime
from pathlib import Path

from fastapi.testclient import TestClient
from httpx import Response

from minibrain.auth.roles import Role
from minibrain.registry.models import ApiKey, AuditEvent
from tests.conftest import Harness
from tests.test_accounts import csrf
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


def test_a_key_left_with_no_models_has_no_access(harness: Harness, tmp_path: Path) -> None:
    two_models(harness, tmp_path)
    orphan = add_key(harness, CUSTOM, name="only-custom")
    add_key(harness, CUSTOM, BASE, name="both")
    harness.client.post(f"/api/models/{SLUG}/deploy", json={"deployed": False})
    assert harness.client.delete(f"/api/models/{SLUG}").status_code == 202
    harness.settle()
    keys = harness.client.get("/api/keys").json()
    found = [(key["name"], key["all_models"], [model["key"] for model in key["models"]], key["status"]) for key in keys]
    assert found == [("both", False, ["base-one"], "active"), ("only-custom", False, [], "no_access")]
    auth = headers(orphan)
    assert harness.client.get("/v1/models", headers=auth).json()["data"] == []
    assert harness.client.post("/v1/chat/completions", headers=auth, json=chat("base-one")).status_code == 403
    with harness.sessions() as session:
        assert session.query(ApiKey).count() == 2


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


def all_models_key(client: TestClient, name: str = "everything") -> Response:
    return client.post("/api/keys", json={"name": name, "all_models": True}, headers=csrf(client))


def test_an_all_models_key_reaches_models_added_later(harness: Harness, tmp_path: Path) -> None:
    created = all_models_key(harness.client)
    assert created.status_code == 201
    key = created.json()
    assert (key["all_models"], key["models"], key["status"]) == (True, [], "active")
    two_models(harness, tmp_path)
    auth = headers(key)
    names = [model["id"] for model in harness.client.get("/v1/models", headers=auth).json()["data"]]
    assert set(names) == {SLUG, f"{SLUG}@0", "base-one"}
    for model in (SLUG, f"{SLUG}@0", "base-one"):
        assert harness.client.post("/v1/chat/completions", headers=auth, json=chat(model)).status_code == 200
    assert harness.client.post("/v1/chat/completions", headers=auth, json=chat("nope")).status_code == 404
    harness.client.post(f"/api/models/{SLUG}/deploy", json={"deployed": False})
    assert harness.client.delete(f"/api/models/{SLUG}").status_code == 202
    harness.settle()
    assert harness.client.post("/v1/chat/completions", headers=auth, json=chat(SLUG)).status_code == 404
    rows = {row["key"]: row["key_count"] for row in harness.client.get("/api/all-models").json()}
    assert rows["base-one"] == 1


def test_all_models_keys_are_for_admins(harness: Harness, tmp_path: Path) -> None:
    two_models(harness, tmp_path)
    builder = harness.person(Role.BUILDER)
    refused = all_models_key(builder)
    assert refused.status_code == 403 and "Admin" in refused.json()["detail"]
    own = builder.post(
        "/api/keys", json={"name": "app", "models": [{"kind": "custom", "key": SLUG}]}, headers=csrf(builder)
    )
    assert own.status_code == 201
    widen = builder.put(f"/api/keys/{own.json()['id']}/models", json={"all_models": True}, headers=csrf(builder))
    assert widen.status_code == 403
    both = {"name": "x", "all_models": True, "models": [{"kind": "custom", "key": SLUG}]}
    assert harness.client.post("/api/keys", json=both).status_code == 422
    everything = all_models_key(harness.client).json()
    clash = all_models_key(harness.client)
    assert clash.status_code == 409 and clash.json()["detail"] == "A key called everything already calls every model."
    narrow = harness.client.put(
        f"/api/keys/{everything['id']}/models", json={"models": [{"kind": "base", "key": "base-one"}]}
    )
    assert narrow.status_code == 200 and narrow.json()["all_models"] is False
    with harness.sessions() as session:
        events = [
            (event.action, event.detail["scope"])
            for event in session.query(AuditEvent).order_by(AuditEvent.id)
            if event.action.startswith("key.")
        ]
    assert events == [("key.create", "models"), ("key.create", "all"), ("key.update", "models")]


def test_builders_see_and_change_only_their_own_keys(harness: Harness, tmp_path: Path) -> None:
    two_models(harness, tmp_path)
    admins = add_key(harness, CUSTOM, name="admins")
    builder = harness.person(Role.BUILDER)
    body = {"name": "builders", "models": [{"kind": "base", "key": "base-one"}]}
    mine = builder.post("/api/keys", json=body, headers=csrf(builder)).json()
    assert mine["created_by"] == "builder@example.com"
    assert [key["name"] for key in builder.get("/api/keys").json()] == ["builders"]
    assert [key["name"] for key in harness.client.get("/api/keys").json()] == ["builders", "admins"]
    assert builder.delete(f"/api/keys/{admins['id']}", headers=csrf(builder)).status_code == 404
    scope = {"models": [{"kind": "base", "key": "base-one"}]}
    assert builder.put(f"/api/keys/{admins['id']}/models", json=scope, headers=csrf(builder)).status_code == 404
    assert builder.delete(f"/api/keys/{mine['id']}", headers=csrf(builder)).status_code == 204
    assert harness.client.delete(f"/api/keys/{admins['id']}").status_code == 204
    assert harness.client.get("/api/keys").json() == []


def test_keys_take_an_expiry_within_the_policy(harness: Harness, tmp_path: Path) -> None:
    two_models(harness, tmp_path)
    custom = [{"kind": "custom", "key": SLUG}]
    soon = harness.client.post("/api/keys", json={"name": "soon", "models": custom, "expires_in_days": 7}).json()
    lasts = datetime.fromisoformat(soon["expires_at"]) - datetime.fromisoformat(soon["created_at"])
    assert lasts.days in (6, 7)
    assert harness.client.put("/api/policies/key_expiry_days", json={"value": 30}).status_code == 200
    late = harness.client.post("/api/keys", json={"name": "late", "models": custom, "expires_in_days": 90})
    assert late.status_code == 422
