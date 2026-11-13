import csv
import io
import json
from datetime import timedelta
from typing import Any

from minibrain.maintenance import purge_audit_events
from minibrain.registry.audit_chain import seal_all
from minibrain.registry.models import ApiKey, AuditEvent, now
from tests.conftest import Harness

LEAKED = "sk-live-0123456789abcdef"


def add_events(harness: Harness, count: int, **fields: Any) -> None:
    with harness.sessions() as session:
        for index in range(count):
            values = {"actor": "admin@example.com", "action": "key.create", "target": f"mb_{index:04d}", "detail": {}}
            session.add(AuditEvent(**(values | fields)))
        session.commit()


def page(harness: Harness, **params: Any) -> dict[str, Any]:
    response = harness.client.get("/api/audit", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def test_pages_run_newest_first_with_cursors(harness: Harness) -> None:
    add_events(harness, 7)
    first = page(harness, limit=3)
    assert [event["target"] for event in first["events"]] == ["mb_0006", "mb_0005", "mb_0004"]
    assert (first["total"], first["newer"], first["newer_cursor"]) == (7, 0, None)
    second = page(harness, limit=3, before=first["older_cursor"])
    assert [event["target"] for event in second["events"]] == ["mb_0003", "mb_0002", "mb_0001"]
    assert second["newer"] == 3
    last = page(harness, limit=3, before=second["older_cursor"])
    assert [event["target"] for event in last["events"]] == ["mb_0000"]
    assert (last["older_cursor"], last["newer"]) == (None, 6)
    back = page(harness, limit=3, after=second["newer_cursor"])
    assert back["events"] == first["events"]
    assert page(harness, limit=3, after=last["newer_cursor"])["events"] == second["events"]


def test_filters_combine_and_facets_count(harness: Harness) -> None:
    add_events(harness, 2)
    add_events(harness, 1, actor="system", action="audit.prune", target="audit_events", detail={"deleted": 4})
    add_events(harness, 1, action="policy.update", target="network", detail={"from": "open", "to": "offline"})
    with harness.sessions() as session:
        old = session.query(AuditEvent).filter(AuditEvent.target == "mb_0000").one()
        old.at = now() - timedelta(days=40)
        session.commit()
    assert page(harness, action=["key.create"])["total"] == 2
    assert page(harness, action=["key.create", "policy.update"])["total"] == 3
    assert [event["action"] for event in page(harness, actor="system")["events"]] == ["audit.prune"]
    assert page(harness, q="OFFLINE")["events"][0]["target"] == "network"
    assert page(harness, q="100%")["total"] == 0
    recent = page(harness, since=(now() - timedelta(days=1)).isoformat())
    assert {event["target"] for event in recent["events"]} == {"mb_0001", "audit_events", "network"}
    older = page(harness, until=(now() - timedelta(days=1)).isoformat(), action="key.create")
    assert [event["target"] for event in older["events"]] == ["mb_0000"]
    facets = harness.client.get("/api/audit/facets").json()
    assert {item["value"]: item["count"] for item in facets["actions"]} == {
        "audit.prune": 1,
        "key.create": 2,
        "policy.update": 1,
    }
    assert {item["value"] for item in facets["actors"]} == {"admin@example.com", "system"}


def test_changes_record_the_peer_address_and_open_by_id(harness: Harness) -> None:
    assert harness.client.put("/api/policies/network", json={"value": "allowlist"}).status_code == 200
    event = page(harness)["events"][0]
    assert (event["action"], event["actor"], event["ip"]) == ("policy.update", "admin@example.com", "testclient")
    forwarded = {"X-Forwarded-For": "203.0.113.9", "X-Real-IP": "203.0.113.9"}
    harness.client.put("/api/policies/network", json={"value": "open"}, headers=forwarded)
    assert page(harness)["events"][0]["ip"] == "testclient"
    assert harness.client.get(f"/api/audit/{event['id']}").json() == event
    assert harness.client.get("/api/audit/999999").status_code == 404


def test_exports_follow_the_filter_and_defuse_formulas(harness: Harness) -> None:
    add_events(harness, 3)
    add_events(harness, 1, action="model.delete", target="=HYPERLINK(1)", detail={"name": "+danger"})
    response = harness.client.get("/api/audit/export", params={"format": "csv", "action": "key.create"})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert response.headers["content-disposition"].startswith('attachment; filename="minibrain-audit-')
    rows = list(csv.DictReader(io.StringIO(response.text)))
    assert [row["target"] for row in rows] == ["mb_0002", "mb_0001", "mb_0000"]
    assert list(rows[0]) == ["id", "seq", "at", "actor", "ip", "action", "target", "detail", "prev_hash", "hash"]
    assert (rows[0]["seq"], rows[0]["hash"]) == ("", "")
    risky = list(csv.DictReader(io.StringIO(harness.client.get("/api/audit/export?action=model.delete").text)))
    assert risky[0]["target"] == "'=HYPERLINK(1)"
    lines = harness.client.get("/api/audit/export", params={"format": "jsonl"}).text.splitlines()
    assert [json.loads(line)["action"] for line in lines] == ["model.delete", "key.create", "key.create", "key.create"]
    assert json.loads(lines[0])["detail"] == {"name": "+danger"}


def test_secrets_in_event_details_never_leave_the_server(harness: Harness) -> None:
    detail = {"name": "bucket", "secret": LEAKED, "nested": {"api_token": LEAKED}, "secret_set": True}
    add_events(harness, 1, action="storage.update", target="storage", detail=detail)
    event = page(harness)["events"][0]
    assert event["detail"] == {
        "name": "bucket",
        "secret": "[redacted]",
        "nested": {"api_token": "[redacted]"},
        "secret_set": True,
    }
    for response in (
        harness.client.get("/api/audit"),
        harness.client.get(f"/api/audit/{event['id']}"),
        harness.client.get("/api/audit/export?format=csv"),
        harness.client.get("/api/audit/export?format=jsonl"),
    ):
        assert response.status_code == 200
        assert LEAKED not in response.text


def test_retention_prunes_old_events_and_records_the_prune(harness: Harness) -> None:
    add_events(harness, 3)
    with harness.sessions() as session:
        assert purge_audit_events(session) == 0
        for event in session.query(AuditEvent).filter(AuditEvent.target != "mb_0002"):
            event.at = now() - timedelta(days=100)
        session.commit()
    assert harness.client.put("/api/policies/audit_retention_days", json={"value": 90}).status_code == 200
    with harness.sessions() as session:
        assert purge_audit_events(session) == 0
        seal_all(session)
        assert purge_audit_events(session) == 2
    events = page(harness)["events"]
    assert [event["action"] for event in events] == ["audit.prune", "policy.update", "key.create"]
    assert (events[0]["actor"], events[0]["ip"]) == ("system", None)
    assert (events[0]["detail"]["deleted"], events[0]["detail"]["days"]) == (2, 90)
    assert events[1]["detail"] == {"from": 0, "to": 90, "sign_in": "local"}


def test_categories_and_targets_filter_and_count(harness: Harness) -> None:
    add_events(harness, 2)
    add_events(harness, 1, action="model.deploy", target="support-bot", detail={"name": "Support bot"})
    add_events(harness, 1, action="version.promote", target="support-bot@4", detail={"name": "Support bot"})
    add_events(harness, 1, action="feedback.accept", target="support-bot/feedback/7", detail={})
    add_events(harness, 1, action="model.deploy", target="support-bot-2", detail={})
    assert page(harness, category="key")["total"] == 2
    assert page(harness, category=["model", "version"])["total"] == 3
    assert page(harness, category="mode")["total"] == 0
    about = page(harness, target="support-bot")
    assert [event["target"] for event in about["events"]] == [
        "support-bot/feedback/7",
        "support-bot@4",
        "support-bot",
    ]
    assert page(harness, target="support-bot", category="version")["total"] == 1
    facets = harness.client.get("/api/audit/facets").json()
    assert {item["value"]: item["count"] for item in facets["categories"]} == {
        "feedback": 1,
        "key": 2,
        "model": 2,
        "version": 1,
    }


def test_events_name_their_actor_and_say_whether_the_target_still_exists(harness: Harness) -> None:
    with harness.sessions() as session:
        key = ApiKey(name="CI pipeline", prefix="mb_live", digest="0" * 64)
        session.add(key)
        session.commit()
        key_id = key.id
    add_events(harness, 1, action="key.create", target="mb_live")
    add_events(harness, 1, action="key.revoke", target="mb_gone")
    add_events(harness, 1, actor=f"api_key:{key_id}", action="safety.block", target="gone-model@2")
    add_events(harness, 1, actor="command line", action="auth.setup_link", target="/setup")
    add_events(harness, 1, action="job.cancel", target="job:999", detail={"kind": "train"})
    add_events(harness, 1, action="account.update", target="admin@example.com")
    add_events(harness, 1, actor="system", action="audit.prune", target="audit_events")
    events = {event["action"]: event for event in page(harness)["events"]}
    assert events["key.create"]["target_ref"] == {"kind": "key", "key": "mb_live", "live": True}
    assert events["key.revoke"]["target_ref"] == {"kind": "key", "key": "mb_gone", "live": False}
    assert events["safety.block"]["target_ref"] == {"kind": "version", "key": "gone-model@2", "live": False}
    assert events["job.cancel"]["target_ref"] == {"kind": "job", "key": "999", "live": False}
    assert events["account.update"]["target_ref"] == {"kind": "account", "key": "admin@example.com", "live": True}
    assert events["auth.setup_link"]["target_ref"] is None
    assert events["audit.prune"]["target_ref"] is None
    kinds = {action: (event["actor_kind"], event["actor_name"]) for action, event in events.items()}
    assert kinds["safety.block"] == ("api_key", "CI pipeline")
    assert kinds["auth.setup_link"] == ("command_line", None)
    assert kinds["audit.prune"] == ("system", None)
    assert kinds["key.create"] == ("user", "Admin")
    one = harness.client.get(f"/api/audit/{events['key.create']['id']}").json()
    assert one == events["key.create"]
    exported = json.loads(harness.client.get("/api/audit/export", params={"format": "jsonl"}).text.splitlines()[0])
    assert set(exported) == {"id", "seq", "at", "actor", "ip", "action", "target", "detail", "prev_hash", "hash"}
