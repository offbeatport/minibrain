import importlib.util
import json
from typing import Any

import pytest

from minibrain.registry.models import JobKind, JudgeScore
from tests.conftest import LABELS, Harness, blank_dataset, give_data, scored_answers, tickets_csv
from tests.test_flow import TIMING, bearer, create_model, finish

INVOICE = {
    "type": "object",
    "properties": {"total": {"type": "number"}, "currency": {"type": "string"}},
    "required": ["total"],
}


def chat_jsonl(rows: int = 120) -> bytes:
    lines = []
    for index in range(rows):
        total = 100 + index
        messages = [
            {"role": "user", "content": f"Invoice {index}: pay {total} EUR by Friday"},
            {"role": "assistant", "content": json.dumps({"total": total, "currency": "EUR"})},
        ]
        lines.append(json.dumps({"messages": messages}))
    return ("\n".join(lines) + "\n").encode()


def upload(harness: Harness, slug: str, name: str, data: bytes) -> dict[str, Any]:
    return give_data(harness, slug, data, name)


def versions(harness: Harness, slug: str) -> list[dict[str, Any]]:
    return harness.client.get(f"/api/models/{slug}/versions").json()


def complete_job(harness: Harness, kind: str, result: dict[str, Any]) -> dict[str, Any]:
    claim = harness.claim([kind])
    assert claim is not None, f"no {kind} job queued"
    body = {"token": claim["token"], "result": result, "outputs": {}}
    assert harness.internal(f"/jobs/{claim['job_id']}/complete", body).status_code == 204
    return claim


def test_a_new_model_starts_with_a_prompt_only_v0_ready_to_test(harness: Harness) -> None:
    created = create_model(harness)
    assert (created["preset"], created["versions"], created["contract_number"]) == ("classify", 1, 1)
    assert created["contract"]["labels"] == list(LABELS)
    assert created["promotion"] == {"thresholds": [], "beats_live": True}
    [v0] = versions(harness, "support-triage")
    assert (v0["number"], v0["kind"], v0["status"], v0["score"]) == (0, "prompt", "ready", None)
    assert v0["promotion"]["passed"] is True
    assert "billing" in v0["instructions"]
    assert v0["graders"] == [{"name": "label_accuracy", "rubric": None, "model": None, "fields": None}]
    tested = harness.client.post(
        "/api/models/support-triage/versions/0/test",
        json={"messages": [{"role": "user", "content": "I was charged twice"}], "expected": "billing"},
    )
    assert tested.status_code == 200, tested.text
    found = tested.json()
    assert (found["answer"], found["valid"]) == ("billing", True)
    assert {(item["metric"], item["value"]) for item in found["scores"]} == {("label_accuracy", 1.0)}
    request = harness.backend.requests[-1]
    assert request.constraint is not None and request.constraint.choices == LABELS
    headers = bearer(harness)
    pinned = {"model": "support-triage@0", "messages": [{"role": "user", "content": "hi"}]}
    assert harness.client.post("/v1/chat/completions", headers=headers, json=pinned).status_code == 200
    live = pinned | {"model": "support-triage"}
    assert harness.client.post("/v1/chat/completions", headers=headers, json=live).status_code == 404


def test_classify_needs_labels_or_data(harness: Harness) -> None:
    refused = harness.client.post(
        "/api/models", json={"dataset": blank_dataset(harness.client), "name": "Router", "preset": "classify"}
    )
    assert refused.status_code == 409
    assert "at least two labels" in refused.json()["detail"]
    assert harness.client.get("/api/models", params={"kind": "custom"}).json() == []


def test_v0_is_scored_at_once_when_the_model_starts_with_data(harness: Harness) -> None:
    create_model(harness, "Seed")
    upload(harness, "seed", "tickets.csv", tickets_csv())
    dataset = harness.client.get("/api/models/seed").json()["dataset"]
    body = {"name": "Router", "preset": "classify", "dataset": dataset}
    created = harness.client.post("/api/models", json=body)
    assert created.status_code == 201, created.text
    [v0] = versions(harness, "router")
    assert (v0["status"], v0["shots"], v0["dataset_slug"]) == ("evaluating", 4, dataset)
    assert sorted(created.json()["contract"]["labels"]) == sorted(LABELS)
    finish(harness, "eval", accuracy=0.9)
    [v0] = versions(harness, "router")
    assert (v0["status"], v0["score"], v0["main_metric"]) == ("ready", 0.9, "label_accuracy")
    scores = {item["metric"]: item for item in v0["held_out"]["scores"]}
    assert scores["label_accuracy"]["grader"] == "label_accuracy" and scores["label_accuracy"]["version"] == 1
    assert "macro_f1" in scores
    assert v0["held_out"]["confusion"] and v0["held_out"]["labels"]


def test_new_labels_in_data_extend_the_contract_but_removing_one_needs_a_confirmation_once_live(
    harness: Harness,
) -> None:
    create_model(harness)
    assert harness.client.post("/api/models/support-triage/versions/0/promote").status_code == 200
    upload(harness, "support-triage", "tickets.csv", tickets_csv())
    fewer = "SELECT text AS input, CASE WHEN category = 'feature' THEN 'refund' ELSE category END AS label FROM source"
    harness.client.put("/api/models/support-triage/mapping", json={"sql": fewer})
    widened = harness.client.post("/api/models/support-triage/versions", json={"kind": "prompt"})
    assert widened.status_code == 201, widened.text
    assert widened.json()["contract"]["labels"] == [*LABELS, "refund"]
    assert widened.json()["contract_number"] == 2
    check = harness.client.post(
        "/api/models/support-triage/contract/check", json={"kind": "json", "labels": ["billing", "bug"]}
    ).json()
    assert check["breaking"] is True and check["against"] == 2
    assert {item["detail"] for item in check["changes"]} >= {'removes "account"', 'removes "refund"'}
    body = {"contract": {"kind": "json", "labels": ["billing", "bug", "account", "feature", "refund", "other"]}}
    additive = harness.client.put("/api/models/support-triage/contract", json=body)
    assert additive.status_code == 200, additive.text
    narrower = {"contract": {"kind": "json", "labels": ["billing", "bug"]}}
    assert harness.client.put("/api/models/support-triage/contract", json=narrower).status_code == 409
    confirmed = harness.client.put("/api/models/support-triage/contract", json=narrower | {"breaking": True})
    assert confirmed.status_code == 200
    narrowed = harness.client.post("/api/models/support-triage/versions", json={"kind": "prompt"})
    assert narrowed.status_code == 201, narrowed.text
    assert narrowed.json()["contract"]["labels"] == ["billing", "bug", "account", "refund"]
    assert narrowed.json()["contract_number"] == 3
    wider = {"contract": {"kind": "json", "labels": ["billing", "bug", "account", "refund", "feature"]}}
    harness.client.put("/api/models/support-triage/contract", json=wider)
    renamed = "SELECT text AS input, CASE WHEN category = 'bug' THEN 'defect' ELSE category END AS label FROM source"
    harness.client.put("/api/models/support-triage/mapping", json={"sql": renamed})
    assert harness.client.post("/api/models/support-triage/versions", json={"kind": "prompt"}).status_code == 201


def test_custom_models_take_a_json_schema_chat_data_and_json_graders(harness: Harness) -> None:
    body = {
        "name": "Invoices",
        "preset": "custom",
        "contract": {"kind": "json", "json_schema": INVOICE},
        "promotion": {"thresholds": [{"metric": "json_valid", "op": "==", "value": 1}], "beats_live": True},
    }
    created = harness.client.post("/api/models", json={"dataset": blank_dataset(harness.client)} | body)
    assert created.status_code == 201, created.text
    detail = upload(harness, "invoices", "invoices.jsonl", chat_jsonl())
    assert detail["mapping"]["template"] == {"messages": "messages"}
    preview = harness.client.get("/api/models/invoices/preview").json()
    assert preview["rows"][0]["input"].startswith("Invoice")
    assert json.loads(preview["rows"][0]["label"])["currency"] == "EUR"
    assert [message["role"] for message in preview["example"]] == ["user", "assistant"]
    version = harness.client.post("/api/models/invoices/versions", json={"kind": "prompt"})
    assert version.status_code == 201, version.text
    found = version.json()
    assert found["contract"] == {"kind": "json", "json_schema": INVOICE, "labels": None}
    assert [item["name"] for item in found["graders"]] == ["json_valid", "json_field_match"]
    assert "JSON Schema" in found["instructions"] and '"total"' in found["instructions"]
    claim = harness.claim([JobKind.EVAL])
    assert claim is not None
    assert claim["params"]["answer_tokens"] == 256
    assert claim["params"]["prompting"]["contract"]["schema"] == INVOICE
    answers = scored_answers(harness, claim["job_id"], 1.0)
    broken = {name: ["not json", *rows[1:]] for name, rows in answers.items()}
    body = {"token": claim["token"], "result": {"metrics": TIMING, "answers": broken}, "outputs": {}}
    assert harness.internal(f"/jobs/{claim['job_id']}/complete", body).status_code == 204
    scored = versions(harness, "invoices")[0]
    values = {item["metric"]: item["value"] for item in scored["held_out"]["scores"]}
    examples = scored["held_out"]["examples"]
    assert values["json_valid"] == pytest.approx((examples - 1) / examples)
    assert scored["main_metric"] == "json_valid"
    assert scored["promotion"]["passed"] is False
    assert {field["field"] for field in scored["held_out"]["fields"]} == {"currency", "total"}
    headers = bearer(harness, ("custom", "invoices"))
    harness.backend.output = '{"total": "lots"}'
    chat = {"model": "invoices@1", "messages": [{"role": "user", "content": "Invoice: pay 5 EUR"}]}
    mismatch = harness.client.post("/v1/chat/completions", headers=headers, json=chat)
    assert mismatch.status_code == 422
    assert "the model's contract" in mismatch.json()["error"]["message"]
    assert harness.backend.requests[-1].constraint is not None
    harness.backend.output = '{"total": 5, "currency": "EUR"}'
    assert harness.client.post("/v1/chat/completions", headers=headers, json=chat).status_code == 200


def test_custom_free_text_with_a_judge_caches_its_scores(harness: Harness) -> None:
    rows = "".join(f"how do I reset {index},Open settings and press reset {index}\n" for index in range(120))
    body = {
        "name": "Helper",
        "preset": "custom",
        "graders": [{"name": "judge", "rubric": "Is the answer correct and polite?", "model": "qwen3-0.6b"}],
    }
    assert harness.client.post("/api/models", json={"dataset": blank_dataset(harness.client)} | body).status_code == 201
    upload(harness, "helper", "help.csv", ("question,answer\n" + rows).encode())
    sql = "SELECT question AS input, answer AS label FROM source"
    assert harness.client.put("/api/models/helper/mapping", json={"sql": sql}).status_code == 200
    first = harness.client.post("/api/models/helper/versions", json={"kind": "prompt"}).json()
    assert first["contract"]["kind"] == "text"
    claim = harness.claim([JobKind.EVAL])
    assert claim is not None
    answers = scored_answers(harness, claim["job_id"], 1.0)
    result = {"metrics": TIMING, "answers": answers}
    assert (
        harness.internal(f"/jobs/{claim['job_id']}/complete", {"token": claim["token"], "result": result}).status_code
        == 204
    )
    assert versions(harness, "helper")[0]["status"] == "evaluating"
    judge = harness.claim([JobKind.JUDGE])
    assert judge is not None
    items = judge["params"]["items"]
    assert len(items) == sum(len(rows) for rows in answers.values())
    assert judge["params"]["rubric"] == "Is the answer correct and polite?"
    scores = {item["key"]: 0.75 for item in items}
    body = {"token": judge["token"], "result": {"scores": scores}}
    assert harness.internal(f"/jobs/{judge['job_id']}/complete", body).status_code == 204
    scored = versions(harness, "helper")[0]
    values = {item["metric"]: item["value"] for item in scored["held_out"]["scores"]}
    assert (scored["status"], values["judge"], scored["held_out"]["judge_pending"]) == ("ready", 0.75, 0)
    with harness.sessions() as session:
        assert session.query(JudgeScore).count() == len(items)
    harness.client.post("/api/models/helper/versions", json={"kind": "prompt"})
    again = harness.claim([JobKind.EVAL])
    assert again is not None
    result = {"metrics": TIMING, "answers": scored_answers(harness, again["job_id"], 1.0)}
    assert (
        harness.internal(f"/jobs/{again['job_id']}/complete", {"token": again["token"], "result": result}).status_code
        == 204
    )
    assert harness.claim([JobKind.JUDGE]) is None
    cached = versions(harness, "helper")[0]
    assert cached["status"] == "ready"
    assert {item["metric"]: item["value"] for item in cached["held_out"]["scores"]}["judge"] == 0.75


def test_graders_must_fit_the_contract(harness: Harness) -> None:
    body = {"name": "Text", "preset": "custom", "graders": [{"name": "label_accuracy"}]}
    refused = harness.client.post("/api/models", json={"dataset": blank_dataset(harness.client)} | body)
    assert refused.status_code == 409
    assert "label set" in refused.json()["detail"]


def test_default_names_count_up_and_names_are_unique_across_base_and_custom_models(harness: Harness) -> None:
    assert harness.client.get("/api/models/name?preset=classify").json()["name"] == "Classifier 1"
    assert harness.client.get("/api/models/name?preset=custom").json()["name"] == "Custom 1"
    create_model(harness, "Classifier 1")
    assert harness.client.get("/api/models/name?preset=classify").json()["name"] == "Classifier 2"
    taken = harness.client.post(
        "/api/models",
        json={
            "dataset": blank_dataset(harness.client),
            "name": "classifier 1",
            "preset": "classify",
            "labels": list(LABELS),
        },
    )
    assert taken.status_code == 409


def test_presets_are_listed_and_recipes_are_gone(harness: Harness) -> None:
    found = harness.client.get("/api/presets").json()
    assert [item["key"] for item in found["presets"]] == ["general", "classify", "custom"]
    assert {item["key"] for item in found["planned"]} == {"extract", "rewrite", "sql"}
    assert "judge" in {item["name"] for item in found["graders"]}
    assert harness.client.get("/api/recipes").status_code == 404
    assert harness.client.post("/api/recipes/ticket-routing/sample").status_code in (404, 405)
    paths = harness.client.get("/api/openapi/api.json").json()["paths"]
    assert not [path for path in paths if "recipe" in path]
    assert importlib.util.find_spec("minibrain.presets.recipes") is None


def test_a_rule_with_a_threshold_blocks_a_version_below_it(harness: Harness) -> None:
    create_model(harness, "Seed")
    upload(harness, "seed", "tickets.csv", tickets_csv())
    dataset = harness.client.get("/api/models/seed").json()["dataset"]
    body = {
        "name": "Gated",
        "preset": "classify",
        "dataset": dataset,
        "promotion": {"thresholds": [{"metric": "label_accuracy", "op": ">=", "value": 0.85}]},
    }
    created = harness.client.post("/api/models", json=body)
    assert created.status_code == 201, created.text
    [v0] = versions(harness, "gated")
    assert v0["status"] == "evaluating"
    assert v0["promotion"] is None
    finish(harness, "eval", accuracy=0.8)
    [v0] = versions(harness, "gated")
    assert v0["promotion"]["passed"] is False
    assert harness.client.post("/api/models/gated/versions/0/promote").status_code == 409


def test_try_with_sample_data_is_a_chat_assistant_offered_the_travel_intents(harness: Harness) -> None:
    created = harness.client.post("/api/models/sample")
    assert created.status_code == 201, created.text
    found = created.json()
    assert (found["name"], found["preset"], found["dataset_name"]) == ("Travel intents", "general", "Travel intents")
    assert found["contract"] == {"kind": "text", "json_schema": None, "labels": None}
    assert found["promotion"] == {"thresholds": [], "beats_live": True}
    assert found["label_proposal"]["labels"] == [
        "book_flight",
        "book_hotel",
        "car_rental",
        "flight_status",
        "lost_luggage",
    ]
    assert found["label_proposal"]["dataset_version_id"] == found["dataset_version"]["id"]
    assert harness.client.post("/api/models/sample").json()["name"] == "Travel intents 2"
