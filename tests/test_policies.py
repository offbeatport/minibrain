from datetime import timedelta
from pathlib import Path

import pytest

from minibrain.maintenance import purge_request_logs
from minibrain.registry.models import ApiKey, AuditEvent, RequestLog, now
from tests.conftest import Harness
from tests.test_flow import SLUG, add_version, bearer, create_with_dataset, finish
from tests.test_models import REPO, add_tiny, hub  # noqa: F401

CHAT = {"model": SLUG, "messages": [{"role": "user", "content": "hello"}]}


def policies(harness: Harness) -> dict[str, dict]:
    return {item["name"]: item for item in harness.client.get("/api/policies").json()}


def set_policy(harness: Harness, name: str, value: object) -> int:
    return harness.client.put(f"/api/policies/{name}", json={"value": value}).status_code


def test_defaults_and_ui_changes_are_audited(harness: Harness) -> None:
    found = policies(harness)
    assert found["network"]["value"] == "open" and found["network"]["locked"] is False
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
            {"from": "open", "to": "allowlist"},
        )
    assert harness.client.get("/api/audit").json()[0]["target"] == "network"


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
    assert set_policy(harness, "request_logs", False) == 200


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
    set_policy(harness, "licences", ["apache-2.0"])
    assert harness.client.post("/api/catalog/tiny/download", json=body).status_code == 202


def test_key_expiry_and_request_log_policies(harness: Harness) -> None:
    create_with_dataset(harness)
    add_version(harness, "prompt")
    finish(harness, "eval", accuracy=0.4)
    set_policy(harness, "key_expiry_days", 30)
    headers = bearer(harness)
    with harness.sessions() as session:
        key = session.query(ApiKey).one()
        assert key.expires_at is not None and key.expires_at > now() + timedelta(days=29)
    set_policy(harness, "request_logs", False)
    assert harness.client.post("/v1/chat/completions", headers=headers, json=CHAT).status_code == 200
    assert harness.flush_logs() == 0
    with harness.sessions() as session:
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
