from pathlib import Path
from typing import Any

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import select, text

from minibrain.gateway.standalone import create_gateway_app
from minibrain.registry.db import make_engine
from minibrain.registry.models import AuditEvent, RequestLog
from tests.conftest import FakeBackend, Harness
from tests.test_access import status, team_of
from tests.test_data_catalogue import columns_of, migration_config
from tests.test_feedback import chat, send
from tests.test_flow import SLUG, add_key
from tests.test_gateway import CHAT, config, servable
from tests.test_keys import BASE, two_models
from tests.test_keys import chat as chat_with
from tests.test_keys import headers as key_headers
from tests.test_policies import policies, set_policy

PATH = f"/api/minibrains/{SLUG}/request-bodies"


def keep(harness: Harness, kept: bool) -> Any:
    return harness.client.put(PATH, json={"kept": kept})


def bodies_of(harness: Harness, slug: str = SLUG) -> dict[str, Any]:
    return harness.client.get(f"/api/minibrains/{slug}").json()["request_bodies"]


def logged(harness: Harness) -> list[tuple[str | None, str | None]]:
    harness.flush_logs()
    with harness.sessions() as session:
        return [(log.input, log.output) for log in session.scalars(select(RequestLog).order_by(RequestLog.id))]


def test_request_metadata_is_always_logged_without_inputs(harness: Harness) -> None:
    headers = servable(harness)
    assert "request_logs" not in policies(harness)
    assert set_policy(harness, "request_logs", False) == 403
    response_id = chat(harness, headers)
    harness.flush_logs()
    with harness.sessions() as session:
        log = session.scalars(select(RequestLog)).one()
        assert (log.model, log.version, log.status, log.response_id, log.finish_reason) == (
            SLUG,
            0,
            200,
            response_id,
            "stop",
        )
        assert log.latency_ms >= 0 and log.prompt_tokens > 0 and (log.input, log.output) == (None, None)
    assert "logging" not in harness.client.get("/api/requests/summary").json()


def test_inputs_and_answers_are_kept_per_model_and_audited(harness: Harness) -> None:
    headers = servable(harness)
    assert bodies_of(harness) == {"kept": False, "locked": False, "source": "model"}
    assert keep(harness, True).json()["request_bodies"]["kept"] is True
    chat(harness, headers)
    assert keep(harness, False).status_code == 200
    chat(harness, headers)
    assert logged(harness) == [("I was charged twice", "billing"), (None, None)]
    with harness.sessions() as session:
        events = session.scalars(select(AuditEvent).where(AuditEvent.action == "model.request_bodies")).all()
        assert [(event.target, event.detail["from"], event.detail["to"]) for event in events] == [
            (SLUG, False, True),
            (SLUG, True, False),
        ]
    people = team_of(harness)
    assert status(people.viewer, "PUT", PATH, {"kept": True}) == 403
    assert status(people.builder, "PUT", PATH, {"kept": True}) == 200
    assert set_policy(harness, "request_bodies", True) == 200
    harness.client.post("/api/minibrains", json={"name": "Other"})
    assert bodies_of(harness, "other")["kept"] is True
    assert set_policy(harness, "request_bodies", False) == 200
    assert bodies_of(harness)["kept"] is True and bodies_of(harness, "other")["kept"] is True


def test_base_models_follow_the_install_default(harness: Harness, tmp_path: Path) -> None:
    two_models(harness, tmp_path)
    both = key_headers(add_key(harness, ("custom", SLUG), BASE))
    assert config(harness).json()["routes"]["base-one"]["request_bodies"] is False
    assert set_policy(harness, "request_bodies", True) == 200
    routes = config(harness).json()["routes"]
    assert (routes["base-one"]["request_bodies"], routes[SLUG]["request_bodies"]) == (True, False)
    assert harness.client.post("/v1/chat/completions", headers=both, json=chat_with("base-one")).status_code == 200
    assert logged(harness)[-1][0] == "I was charged twice"


def test_an_admin_lock_fixes_every_model_to_the_default(harness: Harness) -> None:
    headers = servable(harness)
    assert keep(harness, True).status_code == 200
    assert set_policy(harness, "request_bodies_locked", True) == 200
    assert bodies_of(harness) == {"kept": False, "locked": True, "source": "ui"}
    refused = keep(harness, False)
    assert refused.status_code == 409 and "Settings, Security" in refused.json()["detail"]
    chat(harness, headers)
    assert set_policy(harness, "request_bodies", True) == 200
    assert bodies_of(harness)["kept"] is True
    chat(harness, headers)
    assert set_policy(harness, "request_bodies", False) == 200
    assert set_policy(harness, "request_bodies_locked", False) == 200
    assert bodies_of(harness) == {"kept": True, "locked": False, "source": "model"}
    assert logged(harness) == [(None, None), ("I was charged twice", "billing")]


def test_the_config_file_and_environment_lock_it_too(
    harness: Harness, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    headers = servable(harness)
    yaml = tmp_path / "minibrain.yaml"
    yaml.write_text("policy:\n  request_bodies: true\n  request_logs: false\n")
    monkeypatch.setenv("MINIBRAIN_CONFIG", str(yaml))
    found = policies(harness)
    assert (
        found["request_bodies_locked"] | {"value": True, "locked": True, "source": "config file"}
        == (found["request_bodies_locked"])
    )
    assert bodies_of(harness) == {"kept": True, "locked": True, "source": "config file"}
    assert keep(harness, False).status_code == 409
    assert set_policy(harness, "request_bodies_locked", False) == 409
    chat(harness, headers)
    assert logged(harness) == [("I was charged twice", "billing")]
    monkeypatch.setenv("MINIBRAIN_POLICY_REQUEST_BODIES_LOCKED", "false")
    assert bodies_of(harness) == {"kept": False, "locked": False, "source": "model"}
    monkeypatch.setenv("MINIBRAIN_POLICY_REQUEST_BODIES_LOCKED", "true")
    monkeypatch.setenv("MINIBRAIN_POLICY_REQUEST_BODIES", "false")
    assert bodies_of(harness) == {"kept": False, "locked": True, "source": "environment"}


def test_feedback_without_input_names_the_model_switch(harness: Harness) -> None:
    headers = servable(harness)
    missing = send(harness, headers, response_id=chat(harness, headers), rating="down")
    assert missing.status_code == 422
    assert "Support Triage does not keep request inputs and answers" in missing.json()["detail"]
    assert "Keep request inputs and answers: turn it on under Deployments, Support Triage" in missing.json()["detail"]
    assert set_policy(harness, "request_bodies_locked", True) == 200
    locked = send(harness, headers, response_id=chat(harness, headers), rating="down")
    assert locked.status_code == 422 and "locked off for every model" in locked.json()["detail"]
    assert set_policy(harness, "request_bodies_locked", False) == 200
    assert keep(harness, True).status_code == 200
    kept = send(harness, headers, response_id=chat(harness, headers), rating="down")
    assert kept.status_code == 201, kept.text
    old = send(harness, headers, response_id="chatcmpl-" + "ef" * 16, rating="down")
    assert old.status_code == 422 and "no kept request has the response ID" in old.json()["detail"]


def test_request_detail_says_when_the_model_does_not_keep_them(harness: Harness) -> None:
    headers = servable(harness)
    chat(harness, headers)
    harness.flush_logs()
    first = harness.client.get("/api/requests").json()["items"][0]["id"]
    detail = harness.client.get(f"/api/requests/{first}").json()
    assert (detail["body"], detail["body_locked"], detail["input"]) == ("off", False, None)
    assert keep(harness, True).status_code == 200
    assert harness.client.get(f"/api/requests/{first}").json()["body"] == "missing"
    assert set_policy(harness, "request_bodies_locked", True) == 200
    locked = harness.client.get(f"/api/requests/{first}").json()
    assert (locked["body"], locked["body_locked"]) == ("off", True)


def test_the_standalone_gateway_follows_each_model(harness: Harness, tmp_path: Path) -> None:
    headers = servable(harness)
    token = harness.settings.secret("gateway_token")
    home = tmp_path / "gateway"
    app = create_gateway_app("http://main", token, home, http=harness.client, backend=FakeBackend(), background=False)
    source = app.state.gateway_config
    assert source.poll(0)
    with TestClient(app) as gateway:
        assert gateway.post("/v1/chat/completions", headers=headers, json=CHAT).status_code == 200
        assert keep(harness, True).status_code == 200
        assert source.poll(0)
        assert source.current().routes[SLUG].request_bodies is True
        assert gateway.post("/v1/chat/completions", headers=headers, json=CHAT).status_code == 200
        assert app.state.request_logs.flush() == 2
    assert logged(harness) == [(None, None), ("I was charged twice", "billing")]


def test_migration_keeps_what_existing_models_did(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MINIBRAIN_CONFIG", str(tmp_path / "absent.yaml"))
    outcomes = []
    for name, settings in (
        ("on", {"policy.request_bodies": "true"}),
        ("off", {}),
        ("logs-off", {"policy.request_bodies": "true", "policy.request_logs": "false"}),
    ):
        engine = make_engine(f"sqlite:///{tmp_path / name}.db", foreign_keys=False)
        alembic = migration_config(engine)
        command.upgrade(alembic, "0033")
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO minibrains (slug, name, task, base_model, deployed, last_version, description, tags, "
                    "created_at) VALUES ('triage', 'Triage', 'classify', 'qwen3-0.6b', 1, -1, '', '[]', "
                    "CURRENT_TIMESTAMP)"
                )
            )
            for key, value in settings.items():
                connection.execute(
                    text("INSERT INTO app_settings (key, value, updated_at) VALUES (:key, :value, CURRENT_TIMESTAMP)"),
                    {"key": key, "value": value},
                )
        command.upgrade(alembic, "0034")
        with engine.connect() as connection:
            kept = connection.execute(text("SELECT request_bodies FROM minibrains")).scalar_one()
            keys = connection.execute(text("SELECT key FROM app_settings ORDER BY key")).scalars().all()
            outcomes.append((name, bool(kept), keys))
        command.downgrade(alembic, "0033")
        assert "request_bodies" not in columns_of(engine, "minibrains")
        engine.dispose()
    assert outcomes == [
        ("on", True, ["policy.request_bodies"]),
        ("off", False, []),
        ("logs-off", False, ["policy.request_bodies"]),
    ]
