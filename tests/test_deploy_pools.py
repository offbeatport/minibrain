from dataclasses import replace
from datetime import timedelta
from typing import Any

import pytest
from sqlalchemy import select, update

from minibrain.auth.engine_tokens import engine_token
from minibrain.base_models import QWEN3_0_6B, BaseModelSpec
from minibrain.models.hardware import GIB, Gpu, NodeReport
from minibrain.registry.models import AuditEvent, Worker, now
from minibrain.serve.backend import CompletionRequest, EngineUnavailableError
from minibrain.serve.engines import EngineBackend, EngineManager, ManagedEngineBackend
from minibrain.serve.host import EngineHost
from minibrain.settings import Settings
from minibrain.worker import MainClient, WorkerConfig
from tests.conftest import Harness, fake_adapter
from tests.test_compute import RACK
from tests.test_flow import SLUG, create_model, create_on_data, finish
from tests.test_routing import FakeEngines, replicas

BASE = QWEN3_0_6B.key
SMALL = replace(RACK, host="pi-01", accelerator="cpu", usable_bytes=GIB // 8, gpus=[], ram_bytes=GIB // 4)
LAPTOP = replace(RACK, host="laptop", accelerator="mps", usable_bytes=GIB // 4, gpus=[Gpu("Apple GPU", GIB // 4)])
BIG_LAPTOP = replace(LAPTOP, usable_bytes=64 * GIB, gpus=[Gpu("Apple GPU", 64 * GIB)])


def join(harness: Harness, pool: str, node: NodeReport = RACK, worker: str | None = None) -> dict[str, Any]:
    body = {"id": worker or f"w-{node.host}", "host": node.host, "kinds": ["train"], "pool": pool}
    body["hardware"] = node.as_dict()
    assert harness.internal("/register", body).status_code == 204
    return body


def deploy(harness: Harness, pool: str | None = None, name: str = SLUG, **extra: Any) -> Any:
    body = {"deployed": True} | ({"pool": pool} if pool is not None else {}) | extra
    return harness.client.post(f"/api/models/{name}/deploy", json=body)


def on_main(harness: Harness, node: NodeReport) -> None:
    harness.app.state.node = node


def host(harness: Harness, body: dict[str, Any]) -> tuple[EngineHost, list[str]]:
    config = WorkerConfig(
        api_url="http://testserver", token=harness.token, home=harness.settings.home / body["id"], pool=body["pool"]
    )
    config.id, config.host, config.hardware = body["id"], body["host"], body["hardware"]
    started: list[str] = []

    class Child:
        def __init__(self, key: str) -> None:
            self.key = key
            started.append(key)

        def shutdown(self) -> None:
            started.remove(self.key)

    found = EngineHost(config, MainClient(config, http=harness.client), launch=lambda key, _token: Child(key))
    return found, started


def deployment(harness: Harness, name: str = SLUG) -> dict[str, Any]:
    return next(row for row in harness.client.get("/api/models").json() if row["key"] == name)["deployment"]


def audits(harness: Harness) -> list[dict[str, Any]]:
    with harness.sessions() as session:
        found = session.scalars(select(AuditEvent).where(AuditEvent.action == "model.deploy").order_by(AuditEvent.id))
        return [event.detail for event in found]


def test_deploy_runs_on_the_pool_asked_for_and_says_so(harness: Harness) -> None:
    on_main(harness, BIG_LAPTOP)
    join(harness, "rack")
    create_model(harness)
    response = deploy(harness, "rack")
    assert response.status_code == 200, response.text
    found = deployment(harness)
    assert (found["pool"], found["replicas"]) == ("rack", 1)
    assert {"version": None, "pool": "rack", "replicas": 1}.items() <= audits(harness)[-1].items()
    config = harness.app.state.gateway_config.current()
    assert config.routes[SLUG].pool == "rack" and config.placements[BASE] == {"rack": 1}
    placement = harness.client.get(f"/api/models/{SLUG}/placement").json()
    assert placement["pool"] == "rack" and placement["automatic"] == "local"
    rack = next(pool for pool in placement["pools"] if pool["name"] == "rack")
    assert rack["fit"]["level"] == "fits" and rack["machines"] == 1


def test_unknown_or_too_small_pools_are_refused(harness: Harness) -> None:
    join(harness, "pi", SMALL)
    create_model(harness)
    missing = deploy(harness, "nowhere")
    assert missing.status_code == 422 and missing.json()["detail"] == "There is no compute pool named nowhere"
    small = deploy(harness, "pi")
    assert small.status_code == 422 and "does not fit in pool pi" in small.json()["detail"]
    assert deployment(harness)["state"] == "not_deployed"


def test_automatic_prefers_this_machine_then_the_roomiest_pool(harness: Harness) -> None:
    join(harness, "rack")
    join(harness, "pi", SMALL)
    create_model(harness)
    on_main(harness, BIG_LAPTOP)
    assert harness.client.get(f"/api/models/{SLUG}/placement").json()["automatic"] == "local"
    on_main(harness, LAPTOP)
    assert harness.client.get(f"/api/models/{SLUG}/placement").json()["automatic"] == "rack"
    assert deploy(harness, "auto").json()["deployed"] and deployment(harness)["pool"] == "rack"


def test_nothing_fits_anywhere_is_refused(harness: Harness) -> None:
    on_main(harness, LAPTOP)
    join(harness, "pi", SMALL)
    create_model(harness)
    refused = deploy(harness)
    assert refused.status_code == 422 and "fits in no compute pool" in refused.json()["detail"]


def test_a_new_pool_moves_a_deployed_model_and_keeps_it_when_left_out(harness: Harness) -> None:
    on_main(harness, BIG_LAPTOP)
    rack = join(harness, "rack")
    create_model(harness)
    assert deploy(harness).status_code == 200 and deployment(harness)["pool"] == "local"
    engine_host, started = host(harness, rack)
    engine_host.reconcile()
    assert started == []
    assert deploy(harness, "rack").status_code == 200
    assert (deployment(harness)["pool"], deployment(harness)["moving_to"]) == ("local", "rack")
    assert audits(harness)[-1]["from_pool"] == "local"
    engine_host.reconcile()
    assert started == [BASE]
    assert deploy(harness, "local").status_code == 200
    assert (deployment(harness)["pool"], deployment(harness)["moving_to"]) == ("local", None)
    engine_host.reconcile()
    assert started == []


def test_promote_keeps_the_pool_or_takes_a_new_one(harness: Harness) -> None:
    on_main(harness, BIG_LAPTOP)
    join(harness, "rack")
    create_on_data(harness)
    finish(harness, "eval", accuracy=0.4)
    promote = f"/api/models/{SLUG}/versions/0/promote"
    assert harness.client.post(promote, json={"pool": "rack"}).status_code == 200
    assert deployment(harness)["pool"] == "rack"
    assert harness.client.post(promote).status_code == 200
    assert deployment(harness)["pool"] == "rack"
    assert harness.client.post(promote, json={"pool": "nowhere"}).status_code == 422


def test_workers_in_the_pool_start_and_stop_its_engines(harness: Harness) -> None:
    on_main(harness, BIG_LAPTOP)
    first = join(harness, "rack")
    second = join(harness, "rack", replace(RACK, host="gpu-02"))
    twin = join(harness, "rack", worker="w-zz-twin")
    local = join(harness, "local", replace(RACK, host="cpu-01"))
    create_model(harness)
    hosts = {name: host(harness, body) for name, body in [("a", first), ("b", second), ("t", twin), ("l", local)]}
    assert deploy(harness, "rack").status_code == 200
    for engine_host, _ in hosts.values():
        engine_host.reconcile()
    assert sorted(len(started) for started in [hosts["a"][1], hosts["b"][1]]) == [0, 1]
    assert hosts["t"][1] == [] and hosts["l"][1] == []
    assert deploy(harness, replicas=2).status_code == 200 and deployment(harness)["replicas"] == 2
    for engine_host, _ in hosts.values():
        engine_host.reconcile()
    assert hosts["a"][1] == [BASE] and hosts["b"][1] == [BASE]
    stopped = harness.client.post(f"/api/models/{SLUG}/deploy", json={"deployed": False})
    assert stopped.status_code in (200, 202)
    for engine_host, _ in hosts.values():
        engine_host.reconcile()
    assert hosts["a"][1] == [] and hosts["b"][1] == []


def worker_body(pool: str) -> dict[str, Any]:
    return {"worker": {"id": "w", "host": "h", "kinds": [], "pool": pool}}


def test_engines_answer_only_with_the_worker_token(harness: Harness) -> None:
    body = worker_body("rack")
    assert harness.client.post("/internal/worker/engines", json=body).status_code == 401
    found = harness.internal("/engines", body).json()
    assert found["engines"] == [] and found["engine_token"] == engine_token(harness.settings, "rack")
    assert harness.settings.secret("gateway_token") not in str(found)
    assert harness.internal("/engines", worker_body("local")).json()["engine_token"] is None


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_worker_token_reaches_no_gateway_endpoint(harness: Harness) -> None:
    worker = bearer(harness.token)
    assert harness.client.get("/internal/gateway/config", headers=worker).status_code == 401
    assert harness.client.get("/internal/gateway/bases", headers=worker).status_code == 401
    engine = {"id": "e", "host": "h", "url": "http://h:1", "base_model": BASE, "engine": "sglang", "state": "ready"}
    assert harness.client.post("/internal/gateway/engines", json=engine, headers=worker).status_code == 401


def test_engine_token_reaches_only_what_engines_need(harness: Harness) -> None:
    token = harness.internal("/engines", worker_body("rack")).json()["engine_token"]
    engine = bearer(token)
    announce = {"id": "e", "host": "h", "url": "http://h:1", "base_model": BASE, "engine": "sglang", "state": "ready"}
    assert (
        harness.client.post("/internal/gateway/engines", json=announce | {"pool": "rack"}, headers=engine).status_code
        == 204
    )
    elsewhere = harness.client.post("/internal/gateway/engines", json=announce, headers=engine)
    assert elsewhere.status_code == 403 and "pool rack only" in elsewhere.json()["detail"]
    assert harness.client.get("/internal/gateway/bases", headers=engine).status_code == 200
    assert harness.client.get("/internal/gateway/artifacts/nope", headers=engine).status_code == 404
    for method, path in [("GET", "/config"), ("POST", "/logs"), ("POST", "/feedback"), ("POST", "/gateways")]:
        refused = harness.client.request(method, f"/internal/gateway{path}", headers=engine, json={})
        assert refused.status_code == 403 and "engine token" in refused.json()["detail"], path
    adapter = harness.upload(fake_adapter(), "adapter", "tar", "adapter")
    data = harness.upload(b"question,answer\n", "dataset_version", "file", "data.csv")
    assert harness.client.get(f"/internal/gateway/artifacts/{adapter}", headers=engine).status_code == 200
    assert harness.client.get(f"/internal/gateway/artifacts/{data}", headers=engine).status_code == 404
    assert harness.client.get(f"/internal/gateway/artifacts/{data}", headers=harness.gateway_headers).status_code == 200
    forged = bearer(token.replace("engine.rack.", "engine.local."))
    assert harness.client.get("/internal/gateway/bases", headers=forged).status_code == 401
    assert harness.client.get("/internal/gateway/bases", headers=bearer("engine.rack.00")).status_code == 401


def announce(harness: Harness, state: str, pool: str = "rack") -> None:
    body = {"id": f"e-{pool}", "host": RACK.host, "url": f"http://{pool}:9000", "base_model": BASE}
    body |= {"engine": "sglang", "state": state, "pool": pool, "managed": True}
    response = harness.client.post("/internal/gateway/engines", json=body, headers=harness.gateway_headers)
    assert response.status_code == 204


def test_status_says_where_it_runs_and_waits_for_a_machine(harness: Harness) -> None:
    on_main(harness, BIG_LAPTOP)
    join(harness, "rack")
    create_model(harness)
    deploy(harness, "rack")
    assert (deployment(harness)["state"], deployment(harness)["waiting"]) == ("starting", False)
    with harness.sessions() as session:
        session.execute(update(Worker).values(seen_at=now() - timedelta(minutes=5)))
        session.commit()
    waiting = deployment(harness)
    assert waiting["waiting"] and waiting["label"] == "Base model · Waiting for a machine"
    announce(harness, "fetching")
    assert deployment(harness)["label"] == "Base model · Fetching weights"
    announce(harness, "ready")
    assert deployment(harness)["state"] == "running"
    row = next(row for row in harness.client.get("/api/models").json() if row["key"] == SLUG)
    assert row["deployment"]["pool"] == "rack" and [item["pool"] for item in row["replicas"]] == ["rack"]


def test_main_starts_no_local_engine_for_a_model_placed_elsewhere(harness: Harness) -> None:
    on_main(harness, BIG_LAPTOP)
    join(harness, "rack")
    create_model(harness)
    deploy(harness, "rack")
    seen: list[tuple[set[str], frozenset[str]]] = []

    def spawn(specs: dict[str, BaseModelSpec], registered: Any, releasing: frozenset[str]) -> dict[str, str]:
        seen.append((set(specs), releasing))
        return {}

    harness.app.state.gateway_config.engines = spawn
    announce(harness, "ready")
    announce(harness, "ready", pool="local")
    config = harness.app.state.gateway_config.rebuild()
    assert BASE not in seen[-1][0] and BASE in seen[-1][1]
    assert {entry["pool"] for entry in config.engines[BASE]} == {"rack", "local"}


def request(pool: str | None) -> CompletionRequest:
    return CompletionRequest(QWEN3_0_6B, [{"role": "user", "content": "hi"}], None, 8, pool=pool)


A, B, C = "http://a:8200", "http://b:8200", "http://c:8200"


def test_gateway_routes_a_deployment_only_to_healthy_engines_in_its_pool() -> None:
    pools = ["local", "rack", "rack"]
    engines = {BASE: [entry | {"pool": pool} for entry, pool in zip(replicas(A, B, C), pools, strict=True)]}
    fake = FakeEngines(failing={B})
    backend = EngineBackend(lambda: engines, http=fake)
    answers = {backend.complete(request("rack")).text for _ in range(4)}
    assert answers == {C}
    assert backend.balancer.state({"url": B}) == "down"
    assert backend.complete(request("local")).text == A
    with pytest.raises(EngineUnavailableError, match="in pool gpu"):
        backend.complete(request("gpu"))


def test_main_never_starts_a_local_engine_for_a_remote_pool(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager = EngineManager(settings, "http://main")
    started: list[str] = []

    def ensure_one(spec: BaseModelSpec) -> str:
        started.append(spec.key)
        raise EngineUnavailableError("started")

    monkeypatch.setattr(manager, "ensure_one", ensure_one)
    backend = ManagedEngineBackend(manager, dict, http=FakeEngines(set()), placements=lambda: {BASE: {"rack": 1}})
    for pool in ("rack", None):
        with pytest.raises(EngineUnavailableError):
            backend.complete(request(pool))
    assert started == []
    with pytest.raises(EngineUnavailableError, match="started"):
        backend.complete(request("local"))
    assert started == [BASE]
