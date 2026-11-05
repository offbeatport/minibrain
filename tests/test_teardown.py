import hashlib
import threading
from datetime import timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, update

from minibrain.app import create_app
from minibrain.auth.roles import Role
from minibrain.base_models import base_model
from minibrain.gateway.standalone import create_gateway_app
from minibrain.ml.completion import Completion
from minibrain.registry.files import store_for
from minibrain.registry.models import (
    ApiKey,
    AuditEvent,
    Gateway,
    Model,
    ModelStatus,
    Teardown,
    Version,
    now,
)
from minibrain.serve.backend import CompletionRequest
from minibrain.serve.engine import create_engine_app
from tests.conftest import ADMIN_EMAIL, FakeBackend, Harness, tickets_csv
from tests.test_flow import SLUG, add_key, add_version, bearer, create_with_dataset, deploy, finish

pytestmark = pytest.mark.both_stores

BASE = "tiny"
WEIGHTS = {"config.json": b'{"architectures": ["Qwen3ForCausalLM"]}', "model.safetensors": b"weights" * 300}
CHAT = {"messages": [{"role": "user", "content": "I was charged twice"}]}
ENGINE = {"id": "e-1", "host": "gpu-1", "url": "http://gpu-1:8300", "engine": "transformers", "state": "ready"}


class FakeEngines:
    def __init__(self, *reports: dict[str, Any]) -> None:
        self.reports = list(reports)
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def request(self, method: str, url: str, *, json: Any = None, **_: Any) -> httpx.Response:
        self.calls.append((url, json))
        report = self.reports.pop(0) if len(self.reports) > 1 else self.reports[0]
        return httpx.Response(200, json=report, request=httpx.Request(method, url))


class BlockingBackend:
    def __init__(self, adapters: set[str]) -> None:
        self.adapters = set(adapters)
        self.started = threading.Event()
        self.release = threading.Event()
        self.unloaded: list[str] = []

    def complete(self, request: CompletionRequest) -> Completion:
        self.started.set()
        self.release.wait(5)
        return Completion(text="billing", prompt_tokens=1, completion_tokens=1, stopped=True, seconds=0.0)

    def status(self) -> list[dict[str, Any]]:
        return [{"base_model": "qwen3-0.6b", "adapters": sorted(self.adapters)}]

    def unload_adapter(self, name: str) -> None:
        self.unloaded.append(name)
        self.adapters.discard(name)


def drained(**changes: Any) -> dict[str, Any]:
    return {"in_flight": 0, "total": 0, "loaded": []} | changes


def add_base(harness: Harness, key: str = BASE, name: str = "Tiny") -> Path:
    folder = harness.settings.home / "models" / key
    folder.mkdir(parents=True)
    files = []
    for path, data in WEIGHTS.items():
        (folder / path).write_bytes(data)
        files.append({"path": path, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    with harness.sessions() as session:
        size = sum(len(data) for data in WEIGHTS.values())
        session.add(
            Model(
                id=key,
                source="download",
                name=name,
                files=files,
                size_bytes=size,
                status=ModelStatus.AVAILABLE,
                repo="test/tiny",
                revision="a" * 40,
            )
        )
        session.commit()
    return folder


def add_custom(harness: Harness, name: str, trained: bool = False) -> str:
    slug = harness.client.post("/api/minibrains", json={"name": name, "base_model": BASE}).json()["slug"]
    if trained:
        files = {"file": ("tickets.csv", tickets_csv(), "text/csv")}
        harness.client.post(f"/api/minibrains/{slug}/source", files=files)
        assert harness.client.post(f"/api/minibrains/{slug}/snapshots").status_code == 201
        created = harness.client.post(f"/api/minibrains/{slug}/versions", json={"kind": "lora", "max_rows": 100})
        assert created.status_code == 201, created.text
        finish(harness, "train")
        finish(harness, "eval", accuracy=0.8)
    return slug


def trained_and_live(harness: Harness) -> None:
    create_with_dataset(harness)
    add_version(harness, "lora")
    finish(harness, "train")
    finish(harness, "eval", accuracy=0.9)
    deploy(harness, 0)


def row(harness: Harness, key: str, kind: str = "custom") -> dict[str, Any] | None:
    found = harness.client.get("/api/models").json()
    return next((item for item in found if item["kind"] == kind and item["key"] == key), None)


def shown(harness: Harness, key: str, kind: str = "custom") -> dict[str, Any]:
    found = row(harness, key, kind)
    assert found is not None, f"{kind} {key} is not listed"
    return found


def events(harness: Harness, action: str) -> list[AuditEvent]:
    with harness.sessions() as session:
        return list(session.scalars(select(AuditEvent).where(AuditEvent.action == action).order_by(AuditEvent.id)))


def teardowns(harness: Harness) -> list[Teardown]:
    with harness.sessions() as session:
        return list(session.scalars(select(Teardown).order_by(Teardown.id)))


def adapter_ids(harness: Harness) -> set[str]:
    with harness.sessions() as session:
        return {item for item in session.scalars(select(Version.adapter_artifact_id)) if item}


def report_gateway(harness: Harness, routes: list[str], host: str = "edge-1") -> None:
    body = {"id": "gateway-edge", "host": host, "version": "v1", "routes": routes, "bases": []}
    response = harness.client.post("/internal/gateway/gateways", json=body, headers=harness.gateway_headers)
    assert response.status_code == 204


def register_engine(harness: Harness, base: str, managed: bool = False, state: str = "ready") -> None:
    body = ENGINE | {"base_model": base, "managed": managed, "state": state}
    response = harness.client.post("/internal/gateway/engines", json=body, headers=harness.gateway_headers)
    assert response.status_code == 204


def age(harness: Harness, minutes: int) -> None:
    with harness.sessions() as session:
        session.execute(update(Teardown).values(started_at=now() - timedelta(minutes=minutes)))
        session.commit()


def test_deleting_a_model_shows_deleting_until_its_files_and_records_are_gone(harness: Harness) -> None:
    create_with_dataset(harness)
    add_version(harness, "lora")
    finish(harness, "train")
    finish(harness, "eval", accuracy=0.9)
    adapters = adapter_ids(harness)
    headers = bearer(harness)
    started = harness.client.delete(f"/api/minibrains/{SLUG}")
    assert started.status_code == 202
    teardown = started.json()["teardown"]
    assert (teardown["kind"], teardown["state"], teardown["label"]) == ("delete", "running", "Deleting")
    assert teardown["started_by"] == ADMIN_EMAIL
    pinned = harness.client.post("/v1/chat/completions", headers=headers, json=CHAT | {"model": f"{SLUG}@0"})
    assert pinned.status_code == 404
    assert harness.client.post(f"/api/minibrains/{SLUG}/versions", json={"kind": "prompt"}).status_code == 409
    harness.settle()
    assert row(harness, SLUG) is None and teardowns(harness) == []
    assert not any(store_for(harness.settings).has(item) for item in adapters)
    [begun] = events(harness, "model.delete")
    [done] = events(harness, "model.delete_finished")
    assert (begun.actor, done.actor, done.target, done.detail["outcome"]) == (ADMIN_EMAIL, ADMIN_EMAIL, SLUG, "done")
    assert done.detail["removed"]["versions"] == 1 and done.detail["removed"]["artifacts"] == len(adapters)


def test_a_live_model_is_deleted_only_with_undeploy_and_stops_first(harness: Harness) -> None:
    trained_and_live(harness)
    refused = harness.client.delete(f"/api/minibrains/{SLUG}")
    assert refused.status_code == 409 and "undeploy it first" in refused.json()["detail"]
    started = harness.client.delete(f"/api/minibrains/{SLUG}", params={"undeploy": True}).json()
    assert started["teardown"]["undeploy"] is True and started["deployment"]["state"] == "stopping"
    harness.settle()
    assert row(harness, SLUG) is None
    assert events(harness, "model.delete")[0].detail["undeploy"] is True


def test_undeploy_shows_stopping_until_every_gateway_and_engine_confirms(harness: Harness) -> None:
    trained_and_live(harness)
    register_engine(harness, "qwen3-0.6b")
    report_gateway(harness, [SLUG, f"{SLUG}@0"])
    engines = FakeEngines(
        drained(in_flight=2, total=2, loaded=[f"{SLUG}-v0"]), drained(loaded=[f"{SLUG}-v0"]), drained()
    )
    harness.app.state.teardowns.http = engines
    stopped = harness.client.post(f"/api/minibrains/{SLUG}/deploy", json={"deployed": False})
    assert stopped.status_code == 202 and stopped.json()["teardown"]["label"] == "Stopping"
    harness.app.state.teardowns.run_once()
    found = shown(harness, SLUG)
    assert found["deployment"]["state"] == "stopping"
    assert found["teardown"]["waiting"] == [
        f"the gateway on edge-1 to stop routing {SLUG}",
        "the engine on gpu-1 to finish 2 requests in flight",
    ]
    report_gateway(harness, [f"{SLUG}@0"])
    harness.app.state.teardowns.run_once()
    assert shown(harness, SLUG)["teardown"]["waiting"] == [f"the engine on gpu-1 to unload {SLUG}-v0"]
    harness.app.state.teardowns.run_once()
    found = shown(harness, SLUG)
    assert found["teardown"] is None and found["deployment"]["state"] == "not_deployed"
    assert engines.calls[0] == ("http://gpu-1:8300/drain", {"routes": [SLUG], "adapters": [f"{SLUG}-v0"]})
    [done] = events(harness, "model.undeploy_finished")
    assert done.detail["outcome"] == "done" and done.detail["stopped"]["adapters"] == [f"{SLUG}-v0"]


def test_a_stop_that_is_never_confirmed_fails_with_the_reason_and_retries(harness: Harness) -> None:
    trained_and_live(harness)
    report_gateway(harness, [SLUG])
    harness.client.post(f"/api/minibrains/{SLUG}/deploy", json={"deployed": False})
    age(harness, 11)
    harness.app.state.teardowns.run_once()
    found = shown(harness, SLUG)
    assert found["deployment"]["state"] == "stop_failed"
    assert found["teardown"]["label"] == "Stop failed"
    assert f"the gateway on edge-1 to stop routing {SLUG}" in found["teardown"]["error"]
    assert events(harness, "model.undeploy_finished")[0].detail["outcome"] == "failed"
    report_gateway(harness, [])
    retried = harness.client.post(f"/api/minibrains/{SLUG}/deploy", json={"deployed": False})
    assert retried.status_code == 202 and retried.json()["teardown"]["state"] == "running"
    harness.settle()
    assert shown(harness, SLUG)["teardown"] is None
    assert [event.detail.get("retry") for event in events(harness, "model.undeploy")] == [None, 2]


def test_deploying_again_cancels_a_stop_in_progress(harness: Harness) -> None:
    trained_and_live(harness)
    report_gateway(harness, [SLUG])
    harness.client.post(f"/api/minibrains/{SLUG}/deploy", json={"deployed": False})
    assert harness.client.post(f"/api/minibrains/{SLUG}/deploy", json={"deployed": True}).status_code == 200
    assert teardowns(harness) == [] and shown(harness, SLUG)["deployment"]["state"] != "stopping"


def test_a_teardown_resumes_after_a_restart(harness: Harness) -> None:
    create_with_dataset(harness)
    assert harness.client.delete(f"/api/minibrains/{SLUG}").status_code == 202
    restarted = create_app(settings=harness.settings, backend=FakeBackend(), background=False, config_max_age=0)
    assert restarted.state.teardowns.run_once() == 1
    assert row(harness, SLUG) is None and teardowns(harness) == []


def test_deleting_and_undeploying_twice_is_one_operation(harness: Harness) -> None:
    trained_and_live(harness)
    report_gateway(harness, [SLUG])
    assert harness.client.post(f"/api/minibrains/{SLUG}/deploy", json={"deployed": False}).status_code == 202
    assert harness.client.post(f"/api/minibrains/{SLUG}/deploy", json={"deployed": False}).status_code == 202
    assert len(teardowns(harness)) == 1 and len(events(harness, "model.undeploy")) == 1
    first = harness.client.delete(f"/api/minibrains/{SLUG}")
    second = harness.client.delete(f"/api/minibrains/{SLUG}")
    assert (first.status_code, second.status_code) == (202, 202)
    assert [item.kind for item in teardowns(harness)] == ["delete"]
    assert len(events(harness, "model.delete")) == 1
    report_gateway(harness, [])
    harness.settle()
    assert row(harness, SLUG) is None


def test_a_base_with_models_built_on_it_is_deleted_only_with_cascade(harness: Harness) -> None:
    add_base(harness)
    add_custom(harness, "Foo")
    add_custom(harness, "Wef")
    refused = harness.client.delete(f"/api/models/base/{BASE}")
    assert refused.status_code == 409
    assert refused.json()["detail"].startswith("Foo and Wef are trained on Tiny; delete them first")
    assert row(harness, BASE, "base") is not None and teardowns(harness) == []


def test_cascade_deletes_the_base_and_every_model_built_on_it(harness: Harness) -> None:
    folder = add_base(harness)
    foo = add_custom(harness, "Foo", trained=True)
    wef = add_custom(harness, "Wef")
    assert harness.client.post(f"/api/minibrains/{foo}/versions/0/promote").status_code == 200
    add_key(harness, ("custom", foo), name="foo-only")
    adapters = adapter_ids(harness)
    live = harness.client.delete(f"/api/models/base/{BASE}", params={"cascade": True})
    assert live.status_code == 409 and "Foo is live" in live.json()["detail"]
    started = harness.client.delete(f"/api/models/base/{BASE}", params={"cascade": True, "undeploy": True})
    assert started.status_code == 202
    teardown = started.json()["teardown"]
    assert (teardown["label"], teardown["models"], teardown["cascade"]) == ("Deleting", ["Foo", "Wef"], True)
    assert {shown(harness, slug)["teardown"]["part_of"] for slug in (foo, wef)} == {"Tiny"}
    harness.settle()
    assert [row(harness, key, kind) for key, kind in ((foo, "custom"), (wef, "custom"), (BASE, "base"))] == [None] * 3
    assert not folder.exists() and teardowns(harness) == []
    assert not any(store_for(harness.settings).has(item) for item in adapters)
    with harness.sessions() as session:
        assert session.query(ApiKey).count() == 0
    started_events = {event.target: event.detail for event in events(harness, "model.delete")}
    assert started_events[BASE]["cascade"] == [foo, wef] and started_events[foo]["with_base"] == "Tiny"
    finished = {event.target: event.detail for event in events(harness, "model.delete_finished")}
    assert set(finished) == {foo, wef, BASE} and finished[BASE]["models"] == ["Foo", "Wef"]


def test_a_base_goes_only_with_the_models_built_on_it_and_takes_its_files(harness: Harness) -> None:
    folder = add_base(harness)
    foo = add_custom(harness, "Foo")
    refused = harness.client.delete(f"/api/models/base/{BASE}")
    assert refused.status_code == 409 and refused.json()["detail"].endswith("delete them with it (cascade=true)")
    assert harness.client.post(f"/api/models/base/{BASE}/remove-files").status_code in (404, 405)
    assert folder.is_dir() and shown(harness, BASE, "base")["availability"]["state"] == "available"
    assert shown(harness, foo)["health"] is None and teardowns(harness) == []
    started = harness.client.delete(f"/api/models/base/{BASE}", params={"cascade": True})
    assert started.status_code == 202 and started.json()["teardown"]["models"] == ["Foo"]
    harness.settle()
    assert not folder.exists() and row(harness, BASE, "base") is None and row(harness, foo) is None
    assert events(harness, "model.delete_finished")[-1].detail["removed"]["size_bytes"] == sum(
        map(len, WEIGHTS.values())
    )


def test_a_failed_delete_shows_the_reason_and_retry_finishes_it(harness: Harness) -> None:
    folder = add_base(harness)
    folder.parent.chmod(0o500)
    try:
        assert harness.client.delete(f"/api/models/base/{BASE}").status_code == 202
        harness.settle()
        found = shown(harness, BASE, "base")
        assert found["teardown"]["label"] == "Delete failed"
        assert "could not remove" in found["teardown"]["error"] and "ermission denied" in found["teardown"]["error"]
        assert events(harness, "model.delete_finished")[0].detail["outcome"] == "failed"
    finally:
        folder.parent.chmod(0o700)
    retried = harness.client.delete(f"/api/models/base/{BASE}")
    assert retried.status_code == 202 and retried.json()["teardown"]["state"] == "running"
    harness.settle()
    assert row(harness, BASE, "base") is None and not folder.exists()
    assert [event.detail["outcome"] for event in events(harness, "model.delete_finished")] == ["failed", "done"]


def test_released_engines_stop_once_nothing_routes_their_base(harness: Harness) -> None:
    add_base(harness)
    assert harness.client.post(f"/api/models/base/{BASE}/deploy", json={"deployed": True}).status_code == 200
    register_engine(harness, BASE, managed=True)
    harness.app.state.teardowns.http = FakeEngines(drained())
    released: list[frozenset[str]] = []

    def spawn(_specs: Any, _registered: Any, releasing: frozenset[str]) -> dict[str, str]:
        released.append(releasing)
        return {}

    harness.app.state.gateway_config.engines = spawn
    assert harness.client.post(f"/api/models/base/{BASE}/deploy", json={"deployed": False}).status_code == 202
    harness.app.state.teardowns.run_once()
    assert shown(harness, BASE, "base")["teardown"]["waiting"] == ["the engine on gpu-1 to stop"]
    harness.app.state.teardowns.run_once()
    assert frozenset({BASE}) in released
    register_engine(harness, BASE, managed=True, state="stopped")
    harness.app.state.teardowns.run_once()
    assert shown(harness, BASE, "base")["teardown"] is None
    assert [event.action for event in events(harness, "model.undeploy")] == ["model.undeploy"]


def test_who_can_delete_and_undeploy(harness: Harness) -> None:
    add_base(harness)
    foo = add_custom(harness, "Foo")
    harness.client.post(f"/api/minibrains/{foo}/deploy", json={"deployed": True})
    viewer = harness.person(Role.VIEWER)
    builder = harness.person(Role.BUILDER)
    assert viewer.delete(f"/api/minibrains/{foo}").status_code == 403
    assert viewer.post(f"/api/minibrains/{foo}/deploy", json={"deployed": False}).status_code == 403
    assert builder.delete(f"/api/models/base/{BASE}", params={"cascade": True}).status_code == 403
    assert builder.post(f"/api/minibrains/{foo}/deploy", json={"deployed": False}).status_code == 202
    assert builder.delete(f"/api/minibrains/{foo}").status_code == 202
    assert events(harness, "model.delete")[0].actor == "builder@example.com"
    harness.settle()
    assert harness.client.delete(f"/api/models/base/{BASE}").status_code == 202


def test_engines_finish_requests_in_flight_before_unloading_an_adapter(tmp_path: Path) -> None:
    backend = BlockingBackend(adapters={"foo-v1"})
    app = create_engine_app(base_model("qwen3-0.6b"), "http://main", "t", tmp_path / "engine", backend=backend)
    body = {"messages": CHAT["messages"], "route": "foo", "adapter": {"name": "foo-v1", "artifact": {}}}
    with TestClient(app) as engine:
        flying = threading.Thread(target=lambda: engine.post("/generate", json=body))
        flying.start()
        assert backend.started.wait(5)
        drain = {"routes": ["foo"], "adapters": ["foo-v1"]}
        assert engine.post("/drain", json=drain).json() == {"in_flight": 1, "total": 1, "loaded": ["foo-v1"]}
        assert backend.unloaded == []
        backend.release.set()
        flying.join(5)
        assert engine.post("/drain", json=drain).json() == {"in_flight": 0, "total": 0, "loaded": []}
        assert backend.unloaded == ["foo-v1"]


def test_standalone_gateways_report_what_they_route(harness: Harness, tmp_path: Path) -> None:
    trained_and_live(harness)
    token = harness.settings.secret("gateway_token")
    app = create_gateway_app("http://main", token, tmp_path / "gateway", http=harness.client, background=False)
    source = app.state.gateway_config
    assert source.poll(0)
    source.report(source.current())
    with harness.sessions() as session:
        found = session.scalars(select(Gateway).where(Gateway.kind == "standalone")).one()
    assert SLUG in found.routes and "qwen3-0.6b" in found.bases
