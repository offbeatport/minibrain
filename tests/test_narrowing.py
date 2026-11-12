from typing import Any

from minibrain.registry.models import AuditEvent
from tests.conftest import LABELS, Harness, give_data
from tests.test_general import pairs_csv

SLUG = "assistant-1"
INVOICE = {"type": "object", "properties": {"total": {"type": "number"}}, "required": ["total"]}
LABELLED = {"kind": "json", "labels": sorted(LABELS)}


def add_assistant(harness: Harness) -> dict[str, Any]:
    name = harness.client.get("/api/models/name").json()["name"]
    created = harness.client.post("/api/models", json={"name": name})
    assert created.status_code == 201, created.text
    return created.json()


def model(harness: Harness, slug: str = SLUG) -> dict[str, Any]:
    return harness.client.get(f"/api/models/{slug}").json()


def contract(harness: Harness, body: dict[str, Any], breaking: bool = False) -> Any:
    return harness.client.put(f"/api/models/{SLUG}/contract", json={"contract": body, "breaking": breaking})


def dismiss(harness: Harness, dataset_version_id: int) -> Any:
    return harness.client.put(
        f"/api/models/{SLUG}/label-proposal/dismissal", json={"dataset_version_id": dataset_version_id}
    )


def test_add_model_needs_only_a_name_and_starts_a_chat_assistant(harness: Harness) -> None:
    created = add_assistant(harness)
    assert (created["name"], created["preset"], created["versions"]) == ("Assistant 1", "general", 1)
    assert created["contract"] == {"kind": "text", "json_schema": None, "labels": None}
    assert (created["went_live"], created["label_proposal"]) == (False, None)
    suggested = harness.client.get("/api/models/name").json()
    assert suggested == {"name": "Assistant 2", "api_name": "assistant-2", "reserved": None}
    taken = harness.client.post("/api/models", json={"name": "assistant 1"})
    assert taken.status_code == 409 and "already exists" in taken.json()["detail"]
    labelled = harness.client.post("/api/models", json={"name": "Router", "labels": ["billing", "bug"]})
    assert labelled.status_code == 409 and "preset classify" in labelled.json()["detail"]
    assert harness.client.get("/api/models/router").status_code == 404


def test_labels_in_attached_data_are_proposed_until_dismissed_for_that_version(harness: Harness) -> None:
    add_assistant(harness)
    assert model(harness)["label_proposal"] is None
    attached = give_data(harness, SLUG)
    proposal = attached["label_proposal"]
    assert proposal["labels"] == sorted(LABELS)
    assert proposal["dataset_version_id"] == attached["dataset_version"]["id"]
    assert proposal["dataset_version_number"] == 1
    dismissed = dismiss(harness, proposal["dataset_version_id"])
    assert dismissed.status_code == 200, dismissed.text
    assert (dismissed.json()["preset"], dismissed.json()["label_proposal"]) == ("general", None)
    assert model(harness)["label_proposal"] is None
    assert dismiss(harness, proposal["dataset_version_id"]).status_code == 200
    with harness.sessions() as session:
        assert session.query(AuditEvent).filter_by(action="model.labels_dismiss").count() == 1
    fewer = "SELECT text AS input, category AS label FROM source WHERE category != 'feature'"
    remapped = harness.client.put(f"/api/models/{SLUG}/mapping", json={"sql": fewer})
    assert remapped.status_code == 200, remapped.text
    again = model(harness)["label_proposal"]
    assert again["labels"] == sorted(set(LABELS) - {"feature"})
    assert again["dataset_version_id"] != proposal["dataset_version_id"]


def test_free_text_data_proposes_nothing_and_a_dismissal_names_its_own_data(harness: Harness) -> None:
    add_assistant(harness)
    attached = give_data(harness, SLUG, pairs_csv("question,answer"), "pairs.csv")
    assert attached["dataset_version"]["labels"] == []
    assert attached["label_proposal"] is None
    other = harness.client.post("/api/models", json={"name": "Other"}).json()
    give_data(harness, other["slug"])
    elsewhere = model(harness, other["slug"])["dataset_version"]["id"]
    refused = dismiss(harness, elsewhere)
    assert refused.status_code == 409 and "not a version" in refused.json()["detail"]


def test_accepting_the_labels_switches_to_classify_with_its_graders_and_view(harness: Harness) -> None:
    add_assistant(harness)
    proposal = give_data(harness, SLUG)["label_proposal"]
    check = harness.client.post(f"/api/models/{SLUG}/contract/check", json=LABELLED).json()
    assert check["breaking"] is False and check["changes"][0]["breaking"] is True
    accepted = contract(harness, {"kind": "json", "labels": proposal["labels"]})
    assert accepted.status_code == 200, accepted.text
    found = accepted.json()
    assert (found["preset"], found["contract"]["labels"], found["label_proposal"]) == (
        "classify",
        sorted(LABELS),
        None,
    )
    assert [item["name"] for item in found["graders"]] == ["label_accuracy"]
    assert found["graders_default"] is True
    version = harness.client.post(f"/api/models/{SLUG}/versions", json={"kind": "prompt"})
    assert version.status_code == 201, version.text
    assert (version.json()["view"], version.json()["contract_number"]) == ("classify", 2)
    assert "billing" in version.json()["instructions"]
    views = {item["number"]: item["view"] for item in harness.client.get(f"/api/models/{SLUG}/versions").json()}
    assert views == {0: "free_text", 1: "classify"}
    with harness.sessions() as session:
        event = session.query(AuditEvent).filter_by(action="model.contract").one()
        assert (event.detail["preset_from"], event.detail["preset"]) == ("general", "classify")


def test_answers_change_by_hand_freely_until_the_model_goes_live(harness: Harness) -> None:
    add_assistant(harness)
    edited = harness.client.put(f"/api/models/{SLUG}/graders", json={"graders": [{"name": "exact_match"}]})
    assert edited.status_code == 200, edited.text
    schema = contract(harness, {"kind": "json", "json_schema": INVOICE})
    assert schema.status_code == 200, schema.text
    assert schema.json()["preset"] == "custom"
    assert [item["name"] for item in schema.json()["graders"]] == ["json_valid", "json_field_match"]
    assert harness.client.post(f"/api/models/{SLUG}/versions", json={"kind": "prompt"}).status_code == 201
    labels = contract(harness, LABELLED)
    assert (labels.status_code, labels.json()["preset"]) == (200, "classify")
    free = contract(harness, {"kind": "text"})
    assert (free.status_code, free.json()["preset"]) == (200, "general")
    assert [item["name"] for item in free.json()["graders"]] == ["text_similarity"]
    version = harness.client.post(f"/api/models/{SLUG}/versions", json={"kind": "prompt"})
    assert version.status_code == 201, version.text
    assert (version.json()["contract_number"], version.json()["view"]) == (3, "free_text")


def test_after_going_live_a_new_answer_kind_is_a_confirmed_breaking_change(harness: Harness) -> None:
    add_assistant(harness)
    assert harness.client.post(f"/api/models/{SLUG}/versions/0/promote").status_code == 200
    proposal = give_data(harness, SLUG)["label_proposal"]
    assert model(harness)["went_live"] is True
    assert proposal["labels"] == sorted(LABELS)
    check = harness.client.post(f"/api/models/{SLUG}/contract/check", json=LABELLED).json()
    assert check["breaking"] is True and check["against"] == 1
    refused = contract(harness, {"kind": "json", "labels": proposal["labels"]})
    assert refused.status_code == 409 and "breaking change" in refused.json()["detail"]
    assert model(harness)["preset"] == "general"
    confirmed = contract(harness, {"kind": "json", "labels": proposal["labels"]}, breaking=True)
    assert (confirmed.status_code, confirmed.json()["preset"]) == (200, "classify")
    version = harness.client.post(f"/api/models/{SLUG}/versions", json={"kind": "prompt"})
    assert version.status_code == 201, version.text
    assert (version.json()["contract_number"], version.json()["view"]) == (2, "classify")
    back = contract(harness, {"kind": "text"})
    assert back.status_code == 409 and "breaking change" in back.json()["detail"]
