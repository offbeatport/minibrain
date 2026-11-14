from datetime import timedelta
from typing import Any

from sqlalchemy import select, update

from minibrain.gateway.config import GatewayConfig
from minibrain.registry.models import AuditEvent, Model, Worker, now
from minibrain.serve.engines import EngineBackend
from tests.conftest import Harness
from tests.test_deploy_pools import (
    BASE,
    BIG_LAPTOP,
    announce,
    deploy,
    deployment,
    host,
    join,
    on_main,
    request,
)
from tests.test_flow import SLUG, create_model
from tests.test_routing import FakeEngines

MOVING = "Moving to rack · local serves until it is ready"


def rebuild(harness: Harness) -> GatewayConfig:
    return harness.app.state.gateway_config.rebuild()


def status(harness: Harness) -> dict[str, Any]:
    return harness.client.get(f"/api/models/{SLUG}/overview").json()["status"]


def moves(harness: Harness) -> list[dict[str, Any]]:
    with harness.sessions() as session:
        found = session.scalars(select(AuditEvent).where(AuditEvent.action == "model.move").order_by(AuditEvent.id))
        return [event.detail for event in found]


def moving_to_rack(harness: Harness) -> tuple[Any, list[str]]:
    on_main(harness, BIG_LAPTOP)
    rack = join(harness, "rack")
    create_model(harness)
    assert deploy(harness).status_code == 200
    announce(harness, "ready", pool="local")
    engine_host, started = host(harness, rack)
    assert deploy(harness, "rack").status_code == 200
    return engine_host, started


def test_the_old_pool_serves_until_the_new_one_is_ready(harness: Harness) -> None:
    engine_host, started = moving_to_rack(harness)
    found = deployment(harness)
    assert (found["pool"], found["moving_to"], found["state"]) == ("local", "rack", "running")
    assert status(harness)["text"] == MOVING
    config = rebuild(harness)
    assert config.routes[SLUG].pool == "local" and config.placements[BASE] == {"local": 1, "rack": 1}
    placement = harness.client.get(f"/api/models/{SLUG}/placement").json()
    assert (placement["pool"], placement["moving_from"]) == ("rack", "local")
    engine_host.reconcile()
    assert started == [BASE]
    announce(harness, "loading")
    assert rebuild(harness).routes[SLUG].pool == "local" and deployment(harness)["moving_to"] == "rack"
    announce(harness, "ready")
    config = rebuild(harness)
    assert config.routes[SLUG].pool == "rack" and config.placements[BASE] == {"rack": 1}
    found = deployment(harness)
    assert (found["pool"], found["moving_to"], found["move_failure"]) == ("rack", None, None)
    assert moves(harness) == [{"name": "Support Triage", "from_pool": "local", "pool": "rack", "outcome": "moved"}]
    engine_host.reconcile()
    assert started == [BASE]


def test_requests_keep_reaching_the_old_pool_during_the_move(harness: Harness) -> None:
    moving_to_rack(harness)
    announce(harness, "loading")
    config = rebuild(harness)
    engines = {BASE: [{"url": "http://old:1", "pool": "local"}, {"url": "http://new:1", "pool": "rack"}]}
    backend = EngineBackend(lambda: engines, http=FakeEngines(set()))
    answers = {backend.complete(request(config.routes[SLUG].pool)).text for _ in range(4)}
    assert answers == {"http://old:1"}


def test_a_failed_engine_rolls_the_move_back(harness: Harness) -> None:
    engine_host, started = moving_to_rack(harness)
    engine_host.reconcile()
    announce(harness, "failed")
    config = rebuild(harness)
    assert config.routes[SLUG].pool == "local" and config.placements[BASE] == {"local": 1}
    found = deployment(harness)
    failure = "Moving to rack failed: its engine in pool rack failed to start. It stays on local."
    assert (found["pool"], found["moving_to"], found["move_failure"]) == ("local", None, failure)
    assert status(harness) == {"tone": "warning", "text": failure, "action": status(harness)["action"]}
    assert status(harness)["action"]["kind"] == "deploy"
    assert moves(harness)[-1]["outcome"] == "rolled_back"
    engine_host.reconcile()
    assert started == []
    assert deploy(harness, "local").status_code == 200 and deployment(harness)["move_failure"] is None


def test_no_machine_in_the_new_pool_rolls_back_after_a_while(harness: Harness) -> None:
    moving_to_rack(harness)
    with harness.sessions() as session:
        session.execute(update(Worker).values(seen_at=now() - timedelta(minutes=5)))
        session.commit()
    rebuild(harness)
    assert deployment(harness)["moving_to"] == "rack"
    with harness.sessions() as session:
        session.execute(update(Model).values(moving_since=now() - timedelta(minutes=6)))
        session.commit()
    rebuild(harness)
    found = deployment(harness)
    assert found["pool"] == "local" and "no machine in pool rack came online within 5 minutes" in found["move_failure"]


def test_moving_back_before_it_finishes_cancels_the_move(harness: Harness) -> None:
    engine_host, started = moving_to_rack(harness)
    engine_host.reconcile()
    assert deploy(harness, "local").status_code == 200
    assert deployment(harness)["moving_to"] is None and rebuild(harness).placements[BASE] == {"local": 1}
    engine_host.reconcile()
    assert started == [] and moves(harness) == []


def test_undeploying_during_a_move_drops_it(harness: Harness) -> None:
    moving_to_rack(harness)
    harness.client.post(f"/api/models/{SLUG}/deploy", json={"deployed": False})
    rebuild(harness)
    with harness.sessions() as session:
        model = session.scalars(select(Model)).one()
        assert (model.moving_from, model.moving_since) == (None, None)
