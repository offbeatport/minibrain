from dataclasses import replace
from datetime import timedelta
from typing import Any

from minibrain.models.hardware import GIB, Gpu, NodeReport, fit
from minibrain.registry.models import EngineReplica, now
from tests.conftest import Harness

RACK = NodeReport(
    host="gpu-01",
    system="linux",
    arch="x86_64",
    cpu_count=64,
    ram_bytes=512 * GIB,
    accelerator="cuda",
    accelerator_name="4 x NVIDIA H100 80GB HBM3 (compute 9.0)",
    usable_bytes=320 * GIB,
    gpus=[Gpu("NVIDIA H100 80GB HBM3", 80 * GIB)] * 4,
    engines=["sglang", "transformers"],
)


def join_rack(harness: Harness) -> None:
    worker = {"id": "w-rack", "host": RACK.host, "kinds": ["train"], "pool": "rack", "hardware": RACK.as_dict()}
    assert harness.internal("/register", worker).status_code == 204


def announce(harness: Harness, **overrides: Any) -> None:
    body = {
        "id": "e-1",
        "host": RACK.host,
        "url": "http://gpu-01:9000",
        "base_model": "qwen3-0.6b",
        "engine": "sglang",
        "state": "ready",
        "pool": "rack",
        "hardware": RACK.as_dict(),
    } | overrides
    response = harness.client.post("/internal/gateway/engines", json=body, headers=harness.gateway_headers)
    assert response.status_code == 204


def by_name(harness: Harness) -> dict[str, dict[str, Any]]:
    return {pool["name"]: pool for pool in harness.client.get("/api/compute/pools").json()}


def test_local_install_is_one_pool_with_this_machine(harness: Harness) -> None:
    pools = harness.client.get("/api/compute/pools").json()
    assert [(pool["name"], pool["label"]) for pool in pools] == [("local", "This machine")]
    main = pools[0]["nodes"][0]
    assert main["roles"] == ["main"] and main["online"] and "transformers" in main["engines"]


def test_workers_and_engines_report_hardware_into_their_pool(harness: Harness) -> None:
    join_rack(harness)
    announce(harness)
    rack = by_name(harness)["rack"]
    node = rack["nodes"][0]
    assert (node["host"], node["accelerator"], len(node["gpus"]), node["roles"]) == (
        "gpu-01",
        "cuda",
        4,
        ["worker", "engine"],
    )
    assert node["usable_bytes"] == 320 * GIB and node["engines"] == ["sglang", "transformers"]
    assert [(e["base_model"], e["engine"], e["state"]) for e in rack["engines"]] == [("qwen3-0.6b", "sglang", "ready")]
    with harness.sessions() as session:
        session.query(EngineReplica).update({"seen_at": now() - timedelta(minutes=5)})
        session.commit()
    assert by_name(harness)["rack"]["engines"] == []


def test_discover_judges_fit_against_the_selected_pool(harness: Harness) -> None:
    join_rack(harness)
    local = harness.client.get("/api/catalog").json()
    assert local["pool"] == "local" and [p["name"] for p in local["pools"]] == ["local", "rack"]
    rack = harness.client.get("/api/catalog", params={"pool": "rack"}).json()
    assert rack["pool"] == "rack" and rack["hardware"]["machine"] == "gpu-01" and rack["hardware"]["gpus"] == 4
    xl = min((e for e in rack["entries"] if e["tier"] == "XL"), key=lambda e: e["variants"][0]["weights_bytes"])
    assert xl["variants"][0]["fit"]["level"] in {"fits", "limited"}
    assert "gpu-01 has 320.0 GB GPU memory" in xl["variants"][0]["fit"]["basis"]
    local_xl = next(entry for entry in local["entries"] if entry["id"] == xl["id"])
    assert local_xl["variants"][0]["fit"]["level"] == "insufficient"


def test_multi_gpu_models_need_several_gpus() -> None:
    one = replace(RACK.hardware(), gpus=1)
    requires = {"gpus": "multi", "note": "Needs several datacenter GPUs."}
    assert fit(60 * GIB, requires, one)["basis"] == "Needs several datacenter GPUs."
    assert fit(60 * GIB, requires, RACK.hardware())["level"] == "fits"
    assert NodeReport.from_dict(RACK.as_dict()) == RACK
