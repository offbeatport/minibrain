from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from minibrain.data.snapshot import read_rows
from minibrain.gateway.standalone import create_gateway_app
from minibrain.registry.files import snapshot_location, store_for
from minibrain.registry.models import AuditEvent, Feedback, RequestLog, Snapshot
from tests.conftest import FakeBackend, Harness
from tests.test_flow import SLUG, add_version, bearer, create_with_dataset, finish
from tests.test_gateway import CHAT, Down, servable

pytestmark = pytest.mark.both_stores


def chat(harness: Harness, headers: dict[str, str]) -> str:
    response = harness.client.post("/v1/chat/completions", headers=headers, json=CHAT)
    assert response.status_code == 200, response.text
    return response.json()["id"]


def send(harness: Harness, headers: dict[str, str], **body: Any) -> Any:
    return harness.client.post("/v1/feedback", headers=headers, json={"model": SLUG} | body)


def played(harness: Harness, text: str, rating: str, output: str = "billing", **extra: Any) -> dict:
    body = {"rating": rating, "input": text, "output": output, "version": 0} | extra
    response = harness.client.post(f"/api/models/{SLUG}/feedback", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def review(harness: Harness, item: dict, decision: str, label: str | None = None) -> Any:
    return harness.client.post(f"/api/feedback/{item['id']}/review", json={"decision": decision, "label": label})


def test_feedback_needs_a_key_that_covers_the_model(harness: Harness) -> None:
    headers = servable(harness)
    response_id = chat(harness, headers)
    body = {"response_id": response_id, "rating": "down", "input": "I was charged twice"}
    assert harness.client.post("/v1/feedback", json={"model": SLUG} | body).status_code == 401
    harness.client.post("/api/models", json={"labels": ["billing", "bug"], "name": "Other"})
    other = bearer(harness, ("custom", "other"))
    assert send(harness, other, **body).status_code == 403
    assert send(harness, headers, **(body | {"model": "nope"})).status_code == 404
    assert send(harness, headers, **(body | {"rating": "meh"})).status_code == 422
    assert send(harness, headers, **body).status_code == 201


def test_without_kept_inputs_the_call_must_carry_the_input(harness: Harness) -> None:
    headers = servable(harness)
    response_id = chat(harness, headers)
    missing = send(harness, headers, response_id=response_id, rating="down", correction="bug")
    assert missing.status_code == 422 and "does not keep request inputs and answers" in missing.json()["detail"]
    sent = send(harness, headers, response_id=response_id, rating="down", correction="bug", input="Charged twice")
    assert sent.status_code == 201 and sent.json()["object"] == "feedback"
    up = send(harness, headers, response_id=response_id, rating="up", correction="bug", input="Charged twice")
    assert up.status_code == 422 and "thumbs-down" in up.json()["detail"]


def test_kept_inputs_let_feedback_name_a_response_by_id(harness: Harness) -> None:
    headers = servable(harness)
    assert harness.client.put(f"/api/models/{SLUG}/request-bodies", json={"kept": True}).status_code == 200
    response_id = chat(harness, headers)
    first = send(harness, headers, response_id=response_id, rating="down")
    assert first.status_code == 201, first.text
    again = send(harness, headers, response_id=response_id, rating="down", correction="bug", comment="double charge")
    assert again.json()["id"] == first.json()["id"]
    with harness.sessions() as session:
        log = session.scalars(select(RequestLog)).one()
        assert (log.response_id, log.input, log.output) == (response_id, "I was charged twice", "billing")
        item = session.scalars(select(Feedback)).one()
        assert (item.input, item.output, item.correction, item.version) == ("I was charged twice", "billing", "bug", 0)
        assert (item.origin, item.key_id, item.status, item.comment) == ("api", log.key_id, "pending", "double charge")
    detail = harness.client.get(f"/api/feedback/{first.json()['id']}").json()
    assert detail["request"]["status"] == 200 and detail["request"]["key_name"] == "ci"
    assert detail["suggestion"] == "bug" and "billing" in detail["labels"]


def test_logs_without_bodies_keep_no_inputs(harness: Harness) -> None:
    headers = servable(harness)
    chat(harness, headers)
    harness.flush_logs()
    with harness.sessions() as session:
        log = session.scalars(select(RequestLog)).one()
        assert log.response_id is not None and (log.input, log.output) == (None, None)


def test_the_queue_puts_disagreement_then_unsure_items_first_and_pages(harness: Harness) -> None:
    create_with_dataset(harness)
    plain = played(harness, "my invoice is wrong", "up")
    unsure = played(harness, "the app crashes", "down")
    first = played(harness, "cannot log in", "down", correction="account")
    second = played(harness, "Cannot  log in", "down", correction="bug")
    page = harness.client.get("/api/feedback", params={"limit": 2}).json()
    assert [item["id"] for item in page["items"]] == [second["id"], first["id"]]
    assert [item["signal"] for item in page["items"]] == ["conflict", "conflict"] and page["total"] == 4
    rest = harness.client.get("/api/feedback", params={"limit": 2, "cursor": page["next_cursor"]}).json()
    assert [item["id"] for item in rest["items"]] == [unsure["id"], plain["id"]]
    assert [item["signal"] for item in rest["items"]] == ["unsure", "none"] and rest["next_cursor"] is None
    detail = harness.client.get(f"/api/feedback/{first['id']}").json()
    assert [item["id"] for item in detail["related"]] == [second["id"]]
    facets = harness.client.get("/api/feedback/facets", params={"status": "pending"}).json()
    assert facets["statuses"] == {"pending": 4} and facets["models"] == {SLUG: 4}
    assert harness.client.get("/api/feedback", params={"model": "nope"}).json()["total"] == 0


def test_review_actions_change_status_and_are_audited(harness: Harness) -> None:
    create_with_dataset(harness)
    corrected = played(harness, "charged twice", "down", correction="billing", output="bug")
    unsure = played(harness, "the app crashes", "down", output="billing")
    liked = played(harness, "my invoice", "up")
    assert review(harness, corrected, "accept").json()["label"] == "billing"
    refused = review(harness, unsure, "accept")
    assert refused.status_code == 422 and "right answer" in refused.json()["detail"]
    fixed = review(harness, unsure, "accept", "bug").json()
    assert (fixed["status"], fixed["label"], fixed["reviewed_by"]) == ("accepted", "bug", "admin@example.com")
    assert review(harness, liked, "reject").json()["status"] == "rejected"
    assigned = harness.client.post(f"/api/feedback/{corrected['id']}/assign", json={"mine": True}).json()
    assert assigned["assignee"] == "admin@example.com"
    mine = harness.client.get("/api/feedback", params={"assignee": "me"}).json()
    assert [item["id"] for item in mine["items"]] == [corrected["id"]]
    accepted = harness.client.get("/api/feedback", params={"status": "accepted"}).json()
    assert {item["id"] for item in accepted["items"]} == {corrected["id"], unsure["id"]}
    with harness.sessions() as session:
        events = session.scalars(select(AuditEvent).where(AuditEvent.action.startswith("feedback."))).all()
        actions = [(event.action, event.target) for event in events]
        assert actions == [
            ("feedback.accept", f"{SLUG}/feedback/{corrected['id']}"),
            ("feedback.fix", f"{SLUG}/feedback/{unsure['id']}"),
            ("feedback.reject", f"{SLUG}/feedback/{liked['id']}"),
            ("feedback.assign", f"{SLUG}/feedback/{corrected['id']}"),
        ]
        assert events[1].detail == {
            "name": "Support Triage",
            "from": "pending",
            "status": "accepted",
            "label": "bug",
            "sign_in": "local",
        }


def snapshot_rows(harness: Harness, snapshot_id: int) -> dict[str, str]:
    with harness.sessions() as session:
        snapshot = session.get(Snapshot, snapshot_id)
        assert snapshot is not None
        location = snapshot_location(session, store_for(harness.settings), snapshot)
    return {text or "": label or "" for _, text, label in read_rows(location)}


def test_accepted_feedback_joins_the_rows_a_new_version_trains_on(harness: Harness) -> None:
    before = create_with_dataset(harness)
    relabel = played(harness, "ticket 0 about billing", "down", correction="bug")
    added = played(harness, "my card was declined", "up", output="billing")
    agrees = played(harness, "ticket 1 about bug", "up", output="bug")
    rejected = played(harness, "ticket 2 about account", "down", correction="feature")
    played(harness, "ticket 3 about feature", "down", correction="bug")
    for item in (relabel, added, agrees):
        assert review(harness, item, "accept").status_code == 200
    review(harness, rejected, "reject")
    summary = harness.client.get(f"/api/models/{SLUG}/feedback/summary").json()
    assert summary == summary | {"version": 0, "total": 5, "accepted": 3, "pending": 1, "rows": 3}
    detail = harness.client.get(f"/api/models/{SLUG}").json()
    assert (detail["snapshot"]["id"], detail["snapshot"]["feedback_rows"]) == (before["id"], 0)
    version = add_version(harness, "prompt")
    assert (version["snapshot_number"], version["snapshot_rows"]) == (before["number"], 201)
    with harness.sessions() as session:
        copy = session.get(Snapshot, version["snapshot_id"])
        assert copy is not None
        assert (copy.base_id, copy.feedback_rows, copy.number) == (before["id"], 2, None)
        assert copy.hash != before["hash"]
    rows = snapshot_rows(harness, version["snapshot_id"])
    assert rows["ticket 0 about billing"] == "bug" and rows["my card was declined"] == "billing"
    assert rows["ticket 2 about account"] == "account" and rows["ticket 3 about feature"] == "feature"
    assert snapshot_rows(harness, before["id"])["ticket 0 about billing"] == "billing"
    finish(harness, "eval")
    again = add_version(harness, "prompt")
    assert again["snapshot_id"] == version["snapshot_id"]
    later = harness.client.get(f"/api/models/{SLUG}/feedback/summary").json()
    assert (later["version"], later["total"], later["accepted"], later["rows"]) == (2, 0, 0, 3)


def test_saving_a_dataset_snapshot_leaves_feedback_out(harness: Harness) -> None:
    before = create_with_dataset(harness)
    review(harness, played(harness, "ticket 0 about billing", "down", correction="bug"), "accept")
    saved = harness.client.post(f"/api/datasets/{before['dataset']}/snapshots").json()
    assert (saved["hash"], saved["feedback_rows"]) == (before["hash"], 0)


def test_standalone_gateway_forwards_feedback_to_main(harness: Harness, tmp_path: Path) -> None:
    headers = servable(harness)
    token = harness.settings.secret("gateway_token")
    home = tmp_path / "gateway"
    app = create_gateway_app("http://main", token, home, http=harness.client, backend=FakeBackend(), background=False)
    assert app.state.gateway_config.poll(0)
    body = {"model": SLUG, "rating": "down", "correction": "bug"}
    with TestClient(app) as gateway:
        response_id = gateway.post("/v1/chat/completions", headers=headers, json=CHAT).json()["id"]
        missing = gateway.post("/v1/feedback", headers=headers, json=body | {"response_id": response_id})
        assert missing.status_code == 422 and "does not keep request inputs" in missing.json()["detail"]
        sent = gateway.post(
            "/v1/feedback", headers=headers, json=body | {"response_id": response_id, "input": "Charged twice"}
        )
        assert sent.status_code == 201, sent.text
    with harness.sessions() as session:
        item = session.scalars(select(Feedback)).one()
        assert (item.input, item.response_id, item.version) == ("Charged twice", response_id, 0)
    offline = create_gateway_app("http://main", token, home, http=Down(), backend=FakeBackend(), background=False)
    with TestClient(offline) as gateway:
        down = gateway.post("/v1/feedback", headers=headers, json=body | {"response_id": "x", "input": "y"})
        assert down.status_code == 503


def test_feedback_is_deleted_with_its_model(harness: Harness) -> None:
    create_with_dataset(harness)
    played(harness, "charged twice", "down", correction="billing")
    assert harness.client.delete(f"/api/models/{SLUG}").status_code == 202
    harness.settle()
    with harness.sessions() as session:
        assert session.scalars(select(Feedback)).all() == []
