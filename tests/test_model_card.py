import hashlib
import json
from typing import Any

from minibrain.data.snapshot import Example
from minibrain.tasks.classify import score
from tests.conftest import LABELS, Harness, fake_adapter
from tests.test_flow import SLUG, create_with_dataset

CARD = f"/api/minibrains/{SLUG}/versions"


def examples(count: int) -> list[Example]:
    return [Example(input=f"held out {index}", label=LABELS[index % 4]) for index in range(count)]


def answers(rows: list[Example], wrong: int) -> list[str]:
    outputs = [row.label for row in rows]
    for index in range(wrong):
        outputs[index * 4] = "bug" if index % 3 else "not a label"
    return outputs


def metrics(wrong: int) -> dict[str, Any]:
    held = examples(30)
    golden = examples(20)
    return {
        "golden": score(golden, answers(golden, wrong // 2), LABELS),
        "eval": score(held, answers(held, wrong), LABELS),
        "latency": {"p50_ms": 41.25, "p95_ms": 80.5},
        "prompt_tokens": 48,
        "device": "cpu",
    }


def complete(harness: Harness, kind: str, result: dict[str, Any], outputs: dict[str, str] | None = None) -> None:
    claim = harness.claim([kind])
    assert claim is not None, f"no {kind} job queued"
    body = {"token": claim["token"], "result": result, "outputs": outputs or {}}
    assert harness.internal(f"/jobs/{claim['job_id']}/complete", body).status_code == 204


def trained_card(harness: Harness) -> dict[str, Any]:
    create_with_dataset(harness)
    assert harness.client.post(CARD, json={"kind": "prompt"}).status_code == 201
    complete(harness, "eval", {"metrics": metrics(wrong=6)})
    assert harness.client.post(f"{CARD}/0/promote").status_code == 200
    assert harness.client.post(CARD, json={"kind": "lora", "max_rows": 120, "epochs": 2}).status_code == 201
    summary = {"max_rows": 120, "epochs": 2.0, "rank": 16, "alpha": 32, "learning_rate": 2e-4, "micro_batch": 8}
    summary |= {"grad_accum": 2, "seq_len": 64, "strategy": "lora", "plan": {"label": "LoRA fp32"}}
    summary |= {"device": "cpu", "examples": 120, "train_seconds": 9.5, "train_loss": 0.43219}
    adapter = harness.upload(fake_adapter(), "adapter", "tar", "adapter")
    complete(harness, "train", {"summary": summary}, {"adapter": adapter})
    complete(harness, "eval", {"metrics": metrics(wrong=5)})
    assert harness.client.post(f"{CARD}/1/promote").status_code == 200
    response = harness.client.get(f"{CARD}/1/card")
    assert response.status_code == 200, response.text
    return response.json()


def test_card_is_built_from_the_stored_version_its_data_and_scores(harness: Harness) -> None:
    exported = trained_card(harness)
    card = exported["card"]
    assert (card["schema_name"], card["schema_version"]) == ("minibrain.model_card", 1)
    assert card["version"] | {"created_at": None} == {
        "id": f"{SLUG}@1",
        "slug": SLUG,
        "name": "Support Triage",
        "number": 1,
        "kind": "lora",
        "status": "ready",
        "created_at": None,
        "created_by": "admin@example.com",
    }
    assert card["purpose"] == {"description": "", "task": "classify", "labels": sorted(LABELS)}
    base = card["base_model"]
    assert (base["key"], base["repo"], base["licence_use"]) == ("qwen3-0.6b", "Qwen/Qwen3-0.6B", "commercial")
    assert base["licence_name"] == "Apache 2.0"
    data = card["training_data"]
    assert (data["dataset_slug"], data["snapshot_rows"]) == (SLUG, 200)
    assert data["splits"] == {"train": 146, "held_out": 30, "test": 20, "few_shot": 4}
    assert [row["rows"] for row in data["label_balance"]] == [50, 50, 50, 50]
    assert sum(row["train"] for row in data["label_balance"]) == 146
    assert [(source["table"], source["kind"]) for source in data["sources"]] == [("tickets", "upload")]
    assert len(data["sources"][0]["fingerprint"]) == 64
    assert {check["check"] for check in data["checks"]} >= {"duplicates", "personal_data", "leakage"}
    assert data["personal_data"]["status"] == "ok"
    training = card["training"]
    assert training["recipe"] == {
        "strategy": "LoRA fp32",
        "max_rows": 120,
        "epochs": 2.0,
        "micro_batch": 8,
        "grad_accum": 2,
        "seq_len": 64,
        "rank": 16,
        "alpha": 32,
        "learning_rate": 0.0002,
    }
    assert (training["examples"], training["train_loss"]) == (120, 0.4322)
    assert (training["run"]["machine"], training["run"]["device"]) == ("test", "cpu")
    evaluation = card["evaluation"]
    assert evaluation["held_out"] == {"examples": 30, "accuracy": 0.8333, "macro_f1": 0.8469, "invalid_rate": 0.0667}
    bug = next(item for item in evaluation["per_label"] if item["label"] == "bug")
    assert (bug["support"], bug["predicted"], bug["correct"], bug["precision"]) == (8, 11, 8, 0.7273)
    assert evaluation["confusion"] == [
        {"expected": "billing", "predicted": "bug", "count": 3},
        {"expected": "billing", "predicted": None, "count": 2},
    ]
    prompt_only = evaluation["prompt_only"]
    assert (prompt_only["number"], prompt_only["same_data"], prompt_only["accuracy_change"]) == (0, True, 0.0333)
    assert evaluation["previous"]["number"] == 0
    kinds = [limit["kind"] for limit in card["limits"]["derived"]]
    assert kinds == ["low_recall", "invalid_outputs", "small_held_out"]
    assert card["limits"]["derived"][0] == {
        "kind": "low_recall",
        "text": "Held-out recall is below 50% for billing (3 of 8).",
        "labels": ["billing"],
    }
    assert card["use"] == {"intended_use": "", "owner": "admin@example.com"}
    assert [(event["actor"], event["summary"]) for event in card["approvals"]] == [
        ("admin@example.com", "Deployed v1, replacing v0")
    ]
    zero = harness.client.get(f"{CARD}/0/card").json()["card"]
    assert [event["kind"] for event in zero["deployments"]] == ["deployed", "replaced"]
    assert zero["evaluation"]["prompt_only"] is None
    assert zero["training"]["few_shot_examples"] == 4


def test_json_export_is_deterministic_and_carries_the_canonical_hash(harness: Harness) -> None:
    exported = trained_card(harness)
    first = harness.client.get(f"{CARD}/1/card.json")
    second = harness.client.get(f"{CARD}/1/card.json")
    assert first.content == second.content
    assert first.headers["content-disposition"] == f'attachment; filename="{SLUG}-v1-model-card.json"'
    envelope = first.json()
    canonical = json.dumps(envelope["card"], sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    assert hashlib.sha256(canonical.encode()).hexdigest() == envelope["sha256"] == exported["sha256"]
    assert envelope["card"]["training"]["recipe"]["epochs"] == 2
    harness.client.post(f"/api/minibrains/{SLUG}/deploy", json={"deployed": False})
    after = harness.client.get(f"{CARD}/1/card.json").json()
    assert after["sha256"] != envelope["sha256"]
    assert after["card"]["deployments"][-1]["summary"] == "Undeployed v1"


def test_markdown_export_renders_every_section_and_the_hash(harness: Harness) -> None:
    exported = trained_card(harness)
    response = harness.client.get(f"{CARD}/1/card.md")
    assert response.headers["content-type"].startswith("text/markdown")
    assert response.headers["content-disposition"] == f'attachment; filename="{SLUG}-v1-model-card.md"'
    text = response.text
    assert text.startswith("# Model card: Support Triage v1\n")
    for heading in ("Purpose", "Intended use and owner", "Base model", "Training data", "Training", "Evaluation"):
        assert f"\n## {heading}\n" in text
    for heading in ("Limits", "Approvals", "Deployment history", "Integrity"):
        assert f"\n## {heading}\n" in text
    assert "| bug | 8 | 11 | 72.7% | 100.0% | 0.842 |" in text
    assert "| Held-out accuracy | 83.3% | 80.0% |" in text
    assert "| Change | \N{EN DASH} | +3.3 pts |" in text
    assert f"`{exported['sha256']}`" in text
    assert text == harness.client.get(f"{CARD}/1/card.md").text


def test_edits_are_stored_per_version_and_audited(harness: Harness) -> None:
    before = trained_card(harness)
    body = {"intended_use": "  Route support tickets to a queue.  ", "known_limits": "English tickets only."}
    edited = harness.client.put(f"{CARD}/1/card", json=body).json()
    assert edited["card"]["use"]["intended_use"] == "Route support tickets to a queue."
    assert edited["card"]["limits"]["known_limits"] == "English tickets only."
    assert edited["sha256"] != before["sha256"]
    assert harness.client.get(f"{CARD}/0/card").json()["card"]["use"]["intended_use"] == ""
    harness.client.put(f"{CARD}/1/card", json={"known_limits": "English tickets only."})
    harness.client.put(f"{CARD}/1/card", json={"known_limits": ""})
    events = harness.client.get("/api/audit", params={"action": ["version.card"]}).json()["events"]
    assert [(event["target"], event["detail"]["to"]) for event in reversed(events)] == [
        (f"{SLUG}@1", {"intended_use": "Route support tickets to a queue.", "known_limits": "English tickets only."}),
        (f"{SLUG}@1", {"known_limits": ""}),
    ]
    assert events[0]["detail"]["from"] == {"known_limits": "English tickets only."}
    assert harness.client.get(f"{CARD}/1/card").json()["card"]["limits"]["known_limits"] == ""
    too_long = harness.client.put(f"{CARD}/1/card", json={"intended_use": "x" * 2001})
    assert too_long.status_code == 422
