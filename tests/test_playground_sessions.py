from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import select

from minibrain.auth.roles import Role
from minibrain.data.splits import read_split
from minibrain.encryption.keys import keys_for
from minibrain.encryption.secrets import FORMAT, needs_reseal
from minibrain.maintenance import purge_playground_sessions
from minibrain.registry.files import dataset_version_location, store_for
from minibrain.registry.models import AuditEvent, DatasetVersion, Feedback, PlaygroundSession, now
from minibrain.registry.playground_sessions import LOCKED_OFF
from tests.conftest import Harness
from tests.test_flow import SLUG, add_version, create_with_dataset
from tests.test_policies import set_policy
from tests.test_safety import import_base

pytestmark = pytest.mark.both_stores

SESSIONS = "/api/playground/sessions"
EXAMPLES = f"/api/models/{SLUG}/test-examples"
FIRST = "Plan three days in Lisbon in May for two people who like food and long walks by the river"
TURNS = [
    {"kind": "user", "id": "a1", "content": FIRST},
    {"kind": "assistant", "id": "a2", "content": "Day one: Alfama.", "reasoning": "", "calls": []},
]
STATE = {"turns": TURNS, "settings": {"temperature": 0.4, "functions": []}, "preset": None}


def chat(harness: Harness, model: str = "spare-base", **extra: Any) -> Any:
    return harness.client.post(SESSIONS, json={"model": model, "state": STATE} | extra)


def kept_for_bases(harness: Harness, tmp_path: Path) -> None:
    import_base(harness, tmp_path, "Spare Base", "spare-base")
    assert set_policy(harness, "request_bodies", True) == 200


def target(harness: Harness, name: str) -> dict[str, Any]:
    targets = harness.client.get("/api/playground/models").json()["targets"]
    return next(item for item in targets if item["name"] == name)


def test_chats_are_saved_reopened_renamed_and_deleted_per_person(harness: Harness, tmp_path: Path) -> None:
    kept_for_bases(harness, tmp_path)
    created = chat(harness)
    assert created.status_code == 201, created.text
    found = created.json()
    assert found["title"] == f"{FIRST[:59].rstrip()}…" and found["model"] == "spare-base"
    assert found["state"] == STATE
    chat_id = found["id"]
    longer = STATE | {"turns": [*TURNS, {"kind": "user", "id": "a3", "content": "And day two?"}], "preset": 4}
    saved = harness.client.put(f"{SESSIONS}/{chat_id}", json={"model": "spare-base", "version": None, "state": longer})
    assert saved.status_code == 200 and saved.json()["state"]["preset"] == 4
    renamed = harness.client.put(f"{SESSIONS}/{chat_id}", json={"title": "  Lisbon  "}).json()
    assert renamed["title"] == "Lisbon" and len(renamed["state"]["turns"]) == 3
    assert chat(harness, title="Porto").json()["title"] == "Porto"
    assert [item["title"] for item in harness.client.get(SESSIONS).json()] == ["Porto", "Lisbon"]
    assert harness.client.get(f"{SESSIONS}/{chat_id}").json()["state"] == longer
    other = harness.person(Role.ADMIN, "other-admin@example.com")
    assert other.get(SESSIONS).json() == []
    assert other.get(f"{SESSIONS}/{chat_id}").status_code == 404
    assert other.put(f"{SESSIONS}/{chat_id}", json={"title": "Mine"}).status_code == 404
    assert other.delete(f"{SESSIONS}/{chat_id}").status_code == 404
    assert harness.client.delete(f"{SESSIONS}/{chat_id}").status_code == 204
    assert [item["title"] for item in harness.client.get(SESSIONS).json()] == ["Porto"]
    assert harness.client.get(f"{SESSIONS}/{chat_id}").status_code == 404


def test_chats_save_unless_request_content_is_locked_off(harness: Harness, tmp_path: Path) -> None:
    import_base(harness, tmp_path, "Spare Base", "spare-base")
    create_with_dataset(harness)
    base = target(harness, "spare-base")
    assert base["chats_saved"] is True and base["chats_note"] is None
    custom = target(harness, f"{SLUG}@0")
    assert custom["chats_saved"] is True
    saved = chat(harness, f"{SLUG}@0", version=0)
    assert saved.status_code == 201, saved.text
    assert set_policy(harness, "request_bodies_locked", True) == 200
    assert target(harness, f"{SLUG}@0")["chats_note"] == LOCKED_OFF
    update = {"model": f"{SLUG}@0", "version": 0, "state": STATE}
    assert harness.client.put(f"{SESSIONS}/{saved.json()['id']}", json=update).status_code == 403
    assert harness.client.put(f"{SESSIONS}/{saved.json()['id']}", json={"title": "Kept"}).status_code == 200
    with harness.sessions() as session:
        assert session.query(PlaygroundSession).count() == 1


def test_chats_are_encrypted_at_rest(harness: Harness, tmp_path: Path) -> None:
    kept_for_bases(harness, tmp_path)
    chat_id = chat(harness).json()["id"]
    with harness.sessions() as session:
        row = session.get(PlaygroundSession, chat_id)
        assert row is not None
        for token in (row.title, row.content):
            assert token.startswith(f"{FORMAT}:") and "Lisbon" not in token and "Alfama" not in token
            assert not needs_reseal(keys_for(harness.settings), token)


def test_retention_deletes_chats_with_no_new_message(harness: Harness, tmp_path: Path) -> None:
    kept_for_bases(harness, tmp_path)
    old, recent = chat(harness).json()["id"], chat(harness).json()["id"]
    assert set_policy(harness, "log_retention_days", 7) == 200
    with harness.sessions() as session:
        row = session.get(PlaygroundSession, old)
        assert row is not None
        row.updated_at = now() - timedelta(days=8)
        session.commit()
        assert purge_playground_sessions(session) == 1
        assert [item.id for item in session.scalars(select(PlaygroundSession))] == [recent]


def test_a_saved_test_example_is_held_out_in_the_next_dataset_version(harness: Harness) -> None:
    before = create_with_dataset(harness)
    messages = [
        {"role": "user", "content": "My invoice is wrong"},
        {"role": "assistant", "content": "Which invoice?"},
        {"role": "user", "content": "March, charged twice"},
    ]
    body = {"messages": messages, "expected": "billing", "output": "bug", "version": 0, "response_id": "chatcmpl-1"}
    assert harness.person(Role.VIEWER).post(EXAMPLES, json=body).status_code == 403
    bad = harness.client.post(EXAMPLES, json=body | {"messages": messages[:2]})
    assert bad.status_code == 422 and "ends with a user message" in bad.json()["detail"]
    saved = harness.client.post(EXAMPLES, json=body)
    assert saved.status_code == 201, saved.text
    item = saved.json()
    assert (item["status"], item["label"], item["correction"]) == ("accepted", "billing", "billing")
    assert item["held_out"] is True
    assert harness.client.get(EXAMPLES).json()[0]["id"] == item["id"]
    summary = harness.client.get(f"/api/models/{SLUG}/feedback/summary").json()
    assert (summary["examples"], summary["rows"], summary["pending"]) == (1, 1, 0)
    dataset = harness.client.get(f"/api/datasets/{before['dataset']}").json()
    assert dataset["test_examples"] == {SLUG: 1}
    with harness.sessions() as session:
        event = session.scalars(select(AuditEvent).where(AuditEvent.action == "feedback.example")).one()
        assert event.actor == "admin@example.com" and event.target == f"{SLUG}/feedback/{item['id']}"
        assert event.detail == event.detail | {"name": "Support Triage", "version": 0, "turns": 3, "split": "eval"}
        stored = session.get(Feedback, item["id"])
        assert stored is not None and stored.messages == messages
    version = add_version(harness, "prompt")
    assert version["dataset_version_id"] != before["id"]
    with harness.sessions() as session:
        copy = session.get(DatasetVersion, version["dataset_version_id"])
        assert copy is not None and (copy.base_id, copy.feedback_rows) == (before["id"], 1)
        location = dataset_version_location(session, store_for(harness.settings), copy)
        assert copy.counts["eval"] == before["counts"]["eval"] + 1
    held_out = read_split(location, "eval")
    [example] = [example for example in held_out if example.expected == "billing" and len(example.turns) == 3]
    assert example.messages() == messages
    assert all(len(row.turns) == 1 for name in ("train", "golden", "shots") for row in read_split(location, name))


def test_a_removed_test_example_leaves_the_held_out_rows(harness: Harness) -> None:
    create_with_dataset(harness)
    body = {"messages": [{"role": "user", "content": "Charged twice in March"}], "expected": "billing"}
    item = harness.client.post(EXAMPLES, json=body).json()
    assert harness.person(Role.VIEWER).delete(f"{EXAMPLES}/{item['id']}").status_code == 403
    assert harness.client.delete(f"{EXAMPLES}/999").status_code == 404
    assert harness.client.delete(f"{EXAMPLES}/{item['id']}").status_code == 204
    assert harness.client.get(EXAMPLES).json() == []
    assert harness.client.delete(f"{EXAMPLES}/{item['id']}").status_code == 422
    assert harness.client.get(f"/api/models/{SLUG}/feedback/summary").json()["examples"] == 0
    with harness.sessions() as session:
        event = session.scalars(select(AuditEvent).where(AuditEvent.action == "feedback.example_remove")).one()
        assert event.target == f"{SLUG}/feedback/{item['id']}"
        stored = session.get(Feedback, item["id"])
        assert stored is not None and stored.status == "rejected"
