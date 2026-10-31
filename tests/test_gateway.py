from contextlib import AbstractContextManager
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from minibrain.base_models import base_model
from minibrain.gateway.standalone import create_gateway_app
from minibrain.registry.models import ApiKey, RequestLog
from minibrain.serve.backend import CompletionRequest
from minibrain.serve.engine import create_engine_app
from minibrain.serve.engines import EngineBackend
from tests.conftest import FakeBackend, Harness
from tests.test_flow import SLUG, add_version, bearer, create_with_dataset, finish

CHAT = {"model": SLUG, "messages": [{"role": "user", "content": "I was charged twice"}]}


def servable(harness: Harness) -> dict[str, str]:
    create_with_dataset(harness)
    add_version(harness, "prompt")
    finish(harness, "eval", accuracy=0.4)
    return bearer(harness)


def config(harness: Harness, query: str = ""):
    return harness.client.get(f"/internal/gateway/config{query}", headers=harness.gateway_headers)


class Down:
    def request(self, method: str, url: str, *, content: Any = None, json: Any = None, headers: Any = None) -> Any:
        raise ConnectionError(f"main is down: {method} {url}")

    def stream(self, method: str, url: str, *, headers: Any = None) -> AbstractContextManager[Any]:
        raise ConnectionError(f"main is down: {method} {url}")


def test_config_snapshot_lists_routes_and_key_hashes(harness: Harness) -> None:
    servable(harness)
    response = config(harness)
    body = response.json()
    assert set(body["routes"]) == {SLUG, f"{SLUG}@0"}
    assert body["routes"][SLUG]["labels"] == ["account", "billing", "bug", "feature"]
    assert len(body["keys"]) == 1
    version = response.headers["etag"]
    assert config(harness, f"?version={version}&wait=0").status_code == 304
    assert harness.client.get("/internal/gateway/config").status_code == 401


def test_config_version_changes_when_routes_change(harness: Harness) -> None:
    servable(harness)
    before = config(harness).headers["etag"]
    add_version(harness, "lora")
    finish(harness, "train")
    finish(harness, "eval", accuracy=0.9)
    harness.client.post(f"/api/minibrains/{SLUG}/versions/1/promote", json={})
    after = config(harness, f"?version={before}&wait=1").json()
    assert after["version"] != before
    assert after["routes"][SLUG]["version"] == 1
    assert after["routes"][SLUG]["adapter"]["name"] == f"{SLUG}-v1"


def test_request_logs_are_written_in_batches(harness: Harness) -> None:
    headers = servable(harness)
    assert harness.client.post("/v1/chat/completions", headers=headers, json=CHAT).status_code == 200
    missing = CHAT | {"model": "nope"}
    assert harness.client.post("/v1/chat/completions", headers=headers, json=missing).status_code == 404
    with harness.sessions() as session:
        assert session.query(RequestLog).count() == 0
    assert harness.flush_logs() == 2
    with harness.sessions() as session:
        logs = session.query(RequestLog).order_by(RequestLog.id).all()
        assert [(log.model, log.status, log.version) for log in logs] == [(SLUG, 200, 0), ("nope", 404, None)]
        assert session.query(ApiKey).one().last_used_at is not None


def test_standalone_gateway_keeps_serving_while_main_is_down(harness: Harness, tmp_path: Path) -> None:
    headers = servable(harness)
    token = harness.settings.secret("gateway_token")
    backend = FakeBackend()
    home = tmp_path / "gateway"
    app = create_gateway_app("http://main", token, home, http=harness.client, backend=backend, background=False)
    assert app.state.gateway_config.poll(0)
    with TestClient(app) as gateway:
        assert gateway.post("/v1/chat/completions", headers=headers, json=CHAT).status_code == 200
        assert app.state.request_logs.flush() == 1
    with harness.sessions() as session:
        assert session.query(RequestLog).count() == 1
    offline = create_gateway_app("http://main", token, home, http=Down(), backend=backend, background=False)
    with pytest.raises(ConnectionError):
        offline.state.gateway_config.poll(0)
    with TestClient(offline) as gateway:
        assert gateway.get("/readyz").status_code == 200
        reply = gateway.post("/v1/chat/completions", headers=headers, json=CHAT)
        assert reply.json()["choices"][0]["message"]["content"] == "billing"
        assert gateway.post("/v1/chat/completions", json=CHAT).status_code == 401
        with pytest.raises(ConnectionError):
            offline.state.request_logs.flush()
        assert len(offline.state.request_logs.entries) == 1


def test_engine_serves_generate_and_health(harness: Harness, tmp_path: Path) -> None:
    fake = FakeBackend(output="bug")
    app = create_engine_app(
        base_model("qwen3-0.6b"), "http://main", "t", tmp_path / "engine", backend=fake, http=harness.client
    )
    with TestClient(app) as engine:
        assert engine.get("/health").json()["base_model"] == "qwen3-0.6b"
        backend = EngineBackend(lambda: {"qwen3-0.6b": [{"url": "http://testserver", "state": "ready"}]}, http=engine)
        request = CompletionRequest(base_model("qwen3-0.6b"), [{"role": "user", "content": "x"}], None, 8)
        assert backend.complete(request).text == "bug"
        assert fake.requests[-1].max_tokens == 8


def test_unknown_engine_is_a_503(harness: Harness) -> None:
    headers = servable(harness)
    harness.app.state.backend = EngineBackend(dict)
    assert harness.client.post("/v1/chat/completions", headers=headers, json=CHAT).status_code == 503
