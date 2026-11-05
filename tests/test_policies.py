from datetime import timedelta
from pathlib import Path

import pytest

from minibrain.app import hub_allowed
from minibrain.maintenance import purge_request_logs
from minibrain.policy import Policy, PolicyError
from minibrain.registry.models import ApiKey, AuditEvent, RequestLog, now
from tests.conftest import Harness
from tests.test_flow import SLUG, bearer, create_on_data, deploy, finish
from tests.test_models import REPO, add_tiny, hub  # noqa: F401

CHAT = {"model": SLUG, "messages": [{"role": "user", "content": "hello"}]}


def policies(harness: Harness) -> dict[str, dict]:
    return {item["name"]: item for item in harness.client.get("/api/policies").json()}


def set_policy(harness: Harness, name: str, value: object) -> int:
    return harness.client.put(f"/api/policies/{name}", json={"value": value}).status_code


def test_defaults_and_ui_changes_are_audited(harness: Harness) -> None:
    found = policies(harness)
    assert found["network"]["value"] == "open" and found["network"]["locked"] is False
    assert found["model_sources"]["value"] == "approved"
    catalog = harness.client.get("/api/catalog").json()
    assert (catalog["hub_add_allowed"], catalog["downloads_allowed"]) == (False, True)
    assert found["safetensors_only"] == found["safetensors_only"] | {"value": True, "locked": True}
    assert set_policy(harness, "network", "allowlist") == 200
    assert set_policy(harness, "network", "everywhere") == 403
    assert set_policy(harness, "safetensors_only", False) == 409
    assert set_policy(harness, "licences", ["cc-by-nc-4.0"]) == 403
    with harness.sessions() as session:
        event = session.query(AuditEvent).one()
        assert (event.action, event.target, event.detail) == (
            "policy.update",
            "network",
            {"from": "open", "to": "allowlist", "sign_in": "local"},
        )
    assert harness.client.get("/api/audit").json()["events"][0]["target"] == "network"


def test_config_file_and_environment_lock_values(
    harness: Harness, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = tmp_path / "minibrain.yaml"
    config.write_text("policy:\n  model_sources: imports\n  log_retention_days: 7\n")
    monkeypatch.setenv("MINIBRAIN_CONFIG", str(config))
    monkeypatch.setenv("MINIBRAIN_POLICY_NETWORK", "offline")
    found = policies(harness)
    assert (found["model_sources"]["value"], found["model_sources"]["source"]) == ("imports", "config file")
    assert (found["network"]["value"], found["network"]["source"]) == ("offline", "environment")
    assert set_policy(harness, "model_sources", "any") == 409
    assert set_policy(harness, "network", "open") == 409
    assert set_policy(harness, "request_bodies", True) == 200


def test_network_policy_gates_every_outbound_path(harness: Harness, hub: Path) -> None:  # noqa: F811
    add_tiny(harness)
    set_policy(harness, "network", "offline")
    body = {"variant": "tiny:bf16", "accept_license": True}
    assert harness.client.post("/api/catalog/tiny/download", json=body).status_code == 403
    assert harness.client.post("/api/catalog/hub", json={"repo": REPO}).status_code == 403
    assert harness.client.get("/api/catalog").json()["offline_forced"] is True
    set_policy(harness, "network", "allowlist")
    set_policy(harness, "allowed_hosts", ["127.0.0.1"])
    assert harness.client.post("/api/catalog/tiny/download", json=body).status_code == 202


def test_model_source_and_licence_policies(harness: Harness, hub: Path) -> None:  # noqa: F811
    add_tiny(harness)
    body = {"variant": "tiny:bf16", "accept_license": True}
    set_policy(harness, "model_sources", "imports")
    assert harness.client.post("/api/catalog/tiny/download", json=body).status_code == 403
    set_policy(harness, "model_sources", "approved")
    assert harness.client.post("/api/catalog/hub", json={"repo": REPO}).status_code == 403
    assert harness.client.post("/api/catalog/tiny/download", json=body).status_code == 403
    set_policy(harness, "model_sources", "any")
    set_policy(harness, "licences", ["mit"])
    assert harness.client.post("/api/catalog/tiny/download", json=body).status_code == 403
    set_policy(harness, "licence_mode", "all")
    assert harness.client.post("/api/catalog/tiny/download", json=body).status_code == 202


def test_any_licence_lets_unreviewed_and_unticked_licences_through() -> None:
    policy = Policy({"model_sources": "any", "licence_mode": "selected", "licences": ["mit"]})
    with pytest.raises(PolicyError, match="not on the allowed list"):
        policy.download("org/model", "apache-2.0", "hub")
    with pytest.raises(PolicyError, match="allow any licence"):
        policy.download("org/model", "other", "hub")
    policy = Policy({"model_sources": "any", "licence_mode": "all", "licences": ["mit"]})
    policy.download("org/model", "apache-2.0", "hub")
    policy.download("org/model", "other", "hub")


def test_key_expiry_policy(harness: Harness) -> None:
    create_on_data(harness)
    finish(harness, "eval", accuracy=0.4)
    deploy(harness)
    set_policy(harness, "key_expiry_days", 30)
    headers = bearer(harness)
    with harness.sessions() as session:
        key = session.query(ApiKey).one()
        assert key.expires_at is not None and key.expires_at > now() + timedelta(days=29)
    assert harness.client.post("/v1/chat/completions", headers=headers, json=CHAT).status_code == 200
    harness.flush_logs()
    with harness.sessions() as session:
        assert session.query(RequestLog).count() == 1
        assert session.query(ApiKey).one().last_used_at is not None
        session.query(ApiKey).update({"expires_at": now() - timedelta(seconds=1)})
        session.commit()
    assert harness.client.post("/v1/chat/completions", headers=headers, json=CHAT).status_code == 401


def test_retention_purges_old_request_logs(harness: Harness) -> None:
    with harness.sessions() as session:
        for days in (1, 40):
            session.add(RequestLog(at=now() - timedelta(days=days), model="m", status=200, latency_ms=1.0))
        session.commit()
        assert purge_request_logs(session) == 1
        assert session.query(RequestLog).count() == 1


def test_local_engines_lose_hub_access_with_the_network(harness: Harness) -> None:
    assert hub_allowed(harness.sessions)
    set_policy(harness, "network", "offline")
    assert not hub_allowed(harness.sessions)


def test_queued_downloads_are_refused_when_the_policy_changes(harness: Harness, hub: Path) -> None:  # noqa: F811
    add_tiny(harness)
    body = {"variant": "tiny:bf16", "accept_license": True}
    assert harness.client.post("/api/catalog/tiny/download", json=body).status_code == 202
    set_policy(harness, "network", "offline")
    assert harness.worker(kinds=["download"]).run_once() is False
    detail = harness.client.get("/api/base-models/tiny").json()
    assert detail["activity"]["state"] == "failed" and "Offline" in (detail["error"] or "")


def test_licence_choices_carry_their_commercial_use(harness: Harness) -> None:
    policies = {item["name"]: item for item in harness.client.get("/api/policies").json()}
    uses = {choice["value"]: choice["use"] for choice in policies["licences"]["choices"]}
    assert uses["apache-2.0"] == "commercial"
    assert uses["llama3.2"] == "restricted"
    assert all(choice.get("use") is None for choice in policies["licence_mode"]["choices"])
