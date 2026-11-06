import json
from pathlib import Path

from minibrain.auth.roles import Role
from minibrain.registry.models import AuditEvent, RequestLog
from tests.conftest import Harness
from tests.test_flow import SLUG, create_on_data, deploy, finish
from tests.test_safety import ASK, GUARD, guarded, import_base
from tests.test_tools import QWEN_TEMPLATE, tool_base

CHAT = "/api/playground/chat/completions"
PRESETS = "/api/playground/presets"
HELLO = [{"role": "user", "content": "Hello"}]


def test_targets_list_versions_live_names_and_installed_bases(harness: Harness, tmp_path: Path) -> None:
    create_on_data(harness)
    finish(harness, "eval", accuracy=0.4)
    deploy(harness)
    tool_base(harness, tmp_path, QWEN_TEMPLATE)
    import_base(harness, tmp_path, "Spare Base", "spare-base")
    import_base(harness, tmp_path, "Llama Guard 3 1B", GUARD)
    found = harness.client.get("/api/playground/models").json()
    targets = {item["name"]: item for item in found["targets"]}
    assert {SLUG, f"{SLUG}@0", "tool-base", "spare-base"} <= set(targets) and GUARD not in targets
    assert targets[SLUG]["live"] and targets[SLUG]["contract"] == "labels" and targets[SLUG]["labels"]
    assert targets[f"{SLUG}@0"]["version"] == 0 and not targets[f"{SLUG}@0"]["live"]
    assert targets["tool-base"]["tools"] == "hermes" and targets["tool-base"]["deployed"]
    assert targets["spare-base"]["deployed"] is False and targets["spare-base"]["tools"] is None
    assert [guard["key"] for guard in found["guards"]] == [GUARD]


def test_viewers_chat_with_bases_that_are_not_deployed_and_streams_work(harness: Harness, tmp_path: Path) -> None:
    import_base(harness, tmp_path, "Spare Base", "spare-base")
    viewer = harness.person(Role.VIEWER)
    harness.backend.output = "Hi there"
    reply = viewer.post(CHAT, json={"model": "spare-base", "messages": HELLO, "temperature": 0.5})
    assert reply.status_code == 200, reply.text
    assert reply.json()["choices"][0]["message"]["content"] == "Hi there"
    assert harness.backend.requests[-1].sampling.temperature == 0.5
    streamed = viewer.post(CHAT, json={"model": "spare-base", "messages": HELLO, "stream": True})
    events = [json.loads(part.removeprefix("data: ")) for part in streamed.text.strip().split("\n\n")[:-1]]
    assert events[0]["choices"][0]["delta"]["content"] == "Hi there"
    assert events[-1]["choices"] == [] and events[-1]["usage"]["prompt_tokens"] == 12
    assert viewer.post(CHAT, json={"model": "nope", "messages": HELLO}).status_code == 404
    bad = viewer.post(CHAT, json={"model": "spare-base", "messages": HELLO, "temperature": 9})
    assert bad.status_code == 400 and bad.json()["error"]["param"] == "temperature"
    harness.flush_logs()
    with harness.sessions() as session:
        assert session.query(RequestLog).count() == 0


def test_blocks_in_the_playground_are_audited_with_the_person(harness: Harness, tmp_path: Path) -> None:
    guarded(harness, tmp_path)
    reply = harness.client.post(CHAT, json={"model": "chat-base", "messages": ASK})
    assert reply.json()["choices"][0]["finish_reason"] == "content_filter"
    with harness.sessions() as session:
        [event] = session.query(AuditEvent).filter(AuditEvent.action == "safety.block").all()
        assert event.actor == "admin@example.com" and event.detail["playground"] is True


def test_presets_are_per_person_with_one_default(harness: Harness) -> None:
    first = harness.client.post(PRESETS, json={"name": "Precise", "settings": {"temperature": 0.1}})
    assert first.status_code == 201, first.text
    second = harness.client.post(
        PRESETS, json={"name": "Creative", "settings": {"temperature": 1.2}, "is_default": True}
    )
    assert second.json()["is_default"] is True
    assert harness.client.post(PRESETS, json={"name": "precise"}).status_code == 409
    preset_id = first.json()["id"]
    renamed = harness.client.put(f"{PRESETS}/{preset_id}", json={"name": "Exact", "is_default": True}).json()
    assert renamed["name"] == "Exact" and renamed["is_default"] is True
    listed = harness.client.get(PRESETS).json()
    assert [(item["name"], item["is_default"]) for item in listed] == [("Creative", False), ("Exact", True)]
    other = harness.person(Role.VIEWER)
    assert other.get(PRESETS).json() == []
    assert other.put(f"{PRESETS}/{preset_id}", json={"name": "Mine"}).status_code == 404
    assert other.delete(f"{PRESETS}/{preset_id}").status_code == 404
    saved = harness.client.put(f"{PRESETS}/{preset_id}", json={"settings": {"temperature": 0.3, "seed": 7}}).json()
    assert saved["settings"] == {"temperature": 0.3, "seed": 7}
    assert harness.client.delete(f"{PRESETS}/{preset_id}").status_code == 204
    assert [item["name"] for item in harness.client.get(PRESETS).json()] == ["Creative"]
