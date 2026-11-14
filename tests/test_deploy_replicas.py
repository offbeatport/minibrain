from dataclasses import replace

from tests.conftest import Harness
from tests.test_compute import RACK
from tests.test_deploy_pools import BASE, BIG_LAPTOP, deploy, deployment, join, on_main
from tests.test_flow import SLUG, create_model, create_on_data, finish


def rooms(harness: Harness) -> dict[str, int]:
    pools = harness.client.get(f"/api/models/{SLUG}/placement").json()["pools"]
    return {pool["name"]: pool["room"] for pool in pools}


def two_machines(harness: Harness) -> None:
    on_main(harness, BIG_LAPTOP)
    join(harness, "rack")
    join(harness, "rack", replace(RACK, host="gpu-02"))


def test_each_pool_says_how_many_replicas_it_has_room_for(harness: Harness) -> None:
    two_machines(harness)
    join(harness, "rack", worker="w-twin")
    create_model(harness)
    assert rooms(harness) == {"local": 1, "rack": 2}


def test_replicas_beyond_the_room_are_refused(harness: Harness) -> None:
    two_machines(harness)
    create_model(harness)
    refused = deploy(harness, "rack", replicas=3)
    assert refused.status_code == 422
    room = "Pool rack has room for 2 replicas of Support Triage: one per online machine where it fits"
    assert refused.json()["detail"] == room
    local = deploy(harness, "local", replicas=2)
    assert local.status_code == 422 and "room for 1 replica of" in local.json()["detail"]
    assert deploy(harness, "rack", replicas=2).status_code == 200 and deployment(harness)["replicas"] == 2


def test_a_live_deployment_changes_its_replicas_in_place(harness: Harness) -> None:
    two_machines(harness)
    create_model(harness)
    assert deploy(harness, "rack").status_code == 200 and deployment(harness)["replicas"] == 1
    assert deploy(harness, replicas=2).status_code == 200
    found = deployment(harness)
    assert (found["pool"], found["replicas"], found["moving_to"]) == ("rack", 2, None)
    assert harness.app.state.gateway_config.rebuild().placements[BASE] == {"rack": 2}


def test_promote_takes_replicas_and_a_move_keeps_what_fits(harness: Harness) -> None:
    two_machines(harness)
    create_on_data(harness)
    finish(harness, "eval", accuracy=0.4)
    promote = f"/api/models/{SLUG}/versions/0/promote"
    assert harness.client.post(promote, json={"pool": "rack", "replicas": 2}).status_code == 200
    assert deployment(harness)["replicas"] == 2
    assert harness.client.post(promote, json={"pool": "local"}).status_code == 200
    assert deployment(harness)["replicas"] == 1
