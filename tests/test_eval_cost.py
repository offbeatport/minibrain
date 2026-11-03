import json
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import select

from minibrain.base_models import BaseModelSpec
from minibrain.ml import evaluate
from minibrain.ml.completion import Completion
from minibrain.ml.context import JobSpec
from minibrain.registry.files import snapshot_dir, store_for
from minibrain.registry.models import AuditEvent, Snapshot
from minibrain.registry.prices import DevicePrices, eval_cost
from tests.conftest import LABELS, Harness, fake_adapter
from tests.test_flow import SLUG, create_with_dataset

BATCH_SECONDS = 0.4
VERSIONS = f"/api/minibrains/{SLUG}/versions"


class FakeRuntime:
    def __init__(self, spec: BaseModelSpec) -> None:
        self.spec = spec
        self.device = "cpu"
        self.batches: list[int] = []

    def render(self, messages: list[dict[str, str]]) -> str:
        return messages[-1]["content"]

    def generate(self, prompts: list[str], adapter: str | None, max_new_tokens: int) -> list[Completion]:
        self.batches.append(len(prompts))
        return [
            Completion(
                text=LABELS[0],
                prompt_tokens=10 + len(prompt) % 3,
                completion_tokens=2,
                stopped=True,
                seconds=BATCH_SECONDS,
            )
            for prompt in prompts
        ]


def snapshot_path(harness: Harness) -> Path:
    create_with_dataset(harness)
    with harness.sessions() as session:
        snapshot = session.scalars(select(Snapshot)).one()
        return snapshot_dir(session, store_for(harness.settings), snapshot)


def measured(device_seconds: float, requests: int = 30, pool: str = "local", device: str = "cuda") -> dict[str, Any]:
    return {
        "source": "device_time",
        "pool": pool,
        "device": device,
        "device_name": "NVIDIA L4",
        "batch_size": 8,
        "requests": requests,
        "device_seconds": device_seconds,
        "prompt_tokens": 80.0,
        "completion_tokens": 2.0,
    }


def result(accuracy: float, device_seconds: float, p50: float) -> dict[str, Any]:
    split = {"examples": 30, "accuracy": accuracy, "macro_f1": accuracy, "invalid_rate": 0.0}
    return {
        "metrics": {
            "eval": split,
            "golden": split | {"examples": 20},
            "latency": {"p50_ms": p50, "p95_ms": p50 * 2},
            "prompt_tokens": 80,
            "device": "cuda",
            "cost": measured(device_seconds),
        }
    }


def complete(harness: Harness, kind: str, body: dict[str, Any], outputs: dict[str, str] | None = None) -> None:
    claim = harness.claim([kind])
    assert claim is not None, f"no {kind} job queued"
    payload = {"token": claim["token"], "result": body, "outputs": outputs or {}}
    assert harness.internal(f"/jobs/{claim['job_id']}/complete", payload).status_code == 204


def two_versions(harness: Harness) -> None:
    create_with_dataset(harness)
    assert harness.client.post(VERSIONS, json={"kind": "prompt"}).status_code == 201
    complete(harness, "eval", result(accuracy=0.54, device_seconds=6.0, p50=120.0))
    assert harness.client.post(VERSIONS, json={"kind": "lora", "max_rows": 120}).status_code == 201
    adapter = harness.upload(fake_adapter(), "adapter", "tar", "adapter")
    complete(harness, "train", {"summary": {"epochs": 1}}, {"adapter": adapter})
    complete(harness, "eval", result(accuracy=0.91, device_seconds=0.3, p50=40.0))


def test_eval_times_the_device_per_batch_of_held_out_rows(
    harness: Harness, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = snapshot_path(harness)
    runtimes: list[FakeRuntime] = []

    def runtime(spec: BaseModelSpec) -> FakeRuntime:
        runtimes.append(FakeRuntime(spec))
        return runtimes[-1]

    monkeypatch.setattr(evaluate, "Runtime", runtime)
    raw = {"snapshot": str(path), "version_kind": "prompt", "slug": SLUG, "number": 0, "base_model": "qwen3-0.6b"}
    spec = JobSpec(raw=raw | {"pool": "gpu-a"}, result_path=tmp_path / "result.json")
    evaluate.main(spec)
    metrics = json.loads(spec.result_path.read_text())["metrics"]
    assert runtimes[0].batches == [1] + [1] * 20 + [8, 8, 8, 6]
    cost = metrics["cost"]
    assert cost | {"device_name": None, "prompt_tokens": None} == {
        "source": "device_time",
        "pool": "gpu-a",
        "device": "cpu",
        "device_name": None,
        "batch_size": 8,
        "requests": 30,
        "device_seconds": pytest.approx(4 * BATCH_SECONDS),
        "prompt_tokens": None,
        "completion_tokens": 2.0,
    }
    assert 10 <= cost["prompt_tokens"] <= 12
    assert metrics["latency"] == {"p50_ms": pytest.approx(400.0), "p95_ms": pytest.approx(400.0)}


def test_cost_needs_a_price_for_the_pool_it_was_measured_on() -> None:
    metrics = {"cost": measured(1.6)}
    unpriced = eval_cost(metrics, DevicePrices())
    assert unpriced is not None
    assert (unpriced.device_seconds_per_1k, unpriced.per_1k, unpriced.currency) == (
        pytest.approx(53.333, 1e-3),
        None,
        None,
    )
    other_pool = eval_cost(metrics, DevicePrices(hourly={"gpu-a": 2.0}))
    assert other_pool is not None and other_pool.per_1k is None
    priced = eval_cost(metrics, DevicePrices(currency="EUR", hourly={"local": 3.6}))
    assert priced is not None
    assert (priced.per_1k, priced.hourly_price, priced.currency) == (pytest.approx(0.05333, 1e-3), 3.6, "EUR")
    assert eval_cost({"cost": measured(1.6, requests=0)}, DevicePrices()) is None
    assert eval_cost({"latency": {"p50_ms": 1.0}}, DevicePrices()) is None


def test_prices_are_set_per_pool_audited_and_cleared_with_zero(harness: Harness) -> None:
    prices = harness.client.get("/api/compute/prices").json()
    assert prices["currency"] == "USD"
    assert [(pool["pool"], pool["hourly_price"]) for pool in prices["pools"]] == [("local", None)]
    saved = harness.client.put("/api/compute/prices", json={"currency": "EUR", "hourly": {"local": 2.5, "old": 1.0}})
    assert saved.status_code == 200, saved.text
    assert saved.json()["currency"] == "EUR"
    assert [(pool["pool"], pool["hourly_price"]) for pool in saved.json()["pools"]] == [("local", 2.5), ("old", 1.0)]
    cleared = harness.client.put("/api/compute/prices", json={"hourly": {"old": 0}}).json()
    assert [(pool["pool"], pool["hourly_price"]) for pool in cleared["pools"]] == [("local", 2.5)]
    assert harness.client.put("/api/compute/prices", json={"currency": "euro"}).status_code == 422
    assert harness.client.put("/api/compute/prices", json={"hourly": {"local": -1}}).status_code == 422
    with harness.sessions() as session:
        events = list(session.scalars(select(AuditEvent).where(AuditEvent.action == "settings.prices")))
    assert [event.detail["to"]["hourly"] for event in events] == [{"local": 2.5, "old": 1.0}, {"local": 2.5}]


def test_versions_report_latency_and_cost_per_thousand_requests(harness: Harness) -> None:
    two_versions(harness)
    row = next(item for item in harness.client.get("/api/models").json() if item["key"] == SLUG)
    trained, prompt = row["versions"]
    assert (trained["latency_p50_ms"], trained["latency_p95_ms"]) == (40.0, 80.0)
    assert trained["cost"]["device_seconds_per_1k"] == pytest.approx(10.0)
    assert prompt["cost"]["device_seconds_per_1k"] == pytest.approx(200.0)
    assert trained["cost"]["per_1k"] is None
    harness.client.put("/api/compute/prices", json={"hourly": {"local": 3.6}})
    versions = harness.client.get(VERSIONS).json()
    assert [version["cost"]["per_1k"] for version in versions] == [pytest.approx(0.01), pytest.approx(0.2)]
    assert versions[0]["cost"]["currency"] == "USD"


def test_card_carries_cost_and_compares_it_with_prompt_only(harness: Harness) -> None:
    two_versions(harness)
    harness.client.put("/api/compute/prices", json={"hourly": {"local": 3.6}})
    card = harness.client.get(f"{VERSIONS}/1/card").json()["card"]
    evaluation = card["evaluation"]
    assert evaluation["cost"] == {
        "source": "device_time",
        "pool": "local",
        "device": "cuda",
        "device_name": "NVIDIA L4",
        "batch_size": 8,
        "requests": 30,
        "device_seconds_per_1k": 10.0,
        "prompt_tokens": 80.0,
        "completion_tokens": 2.0,
        "hourly_price": 3.6,
        "currency": "USD",
        "per_1k": 0.01,
    }
    baseline = evaluation["prompt_only"]
    assert (baseline["latency_p95_ms"], baseline["cost"]["per_1k"]) == (240.0, 0.2)
    first = harness.client.get(f"{VERSIONS}/1/card.json").content
    assert harness.client.get(f"{VERSIONS}/1/card.json").content == first
    markdown = harness.client.get(f"{VERSIONS}/1/card.md").text
    assert "| Device time per 1,000 requests | 10 s of GPU time | 3 min 20 s of GPU time |" in markdown
    assert "| Cost per 1,000 requests | 0.01 USD at 3.60 USD per device hour |" in markdown
    harness.client.put("/api/compute/prices", json={"hourly": {"local": 0}})
    unpriced = harness.client.get(f"{VERSIONS}/1/card.md").text
    assert "| Cost per 1,000 requests | No price per hour set for pool local |" in unpriced
