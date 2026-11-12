import json
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

import pytest

from minibrain.base_models import QWEN3_0_6B
from minibrain.gateway.safety import (
    ANSWER,
    PROMPT,
    SAFEGUARD_POLICY,
    SafetyPlan,
    guard_calls,
    judged,
    verdict_of,
)
from minibrain.ml.completion import Completion
from minibrain.registry.models import AuditEvent, RequestLog
from minibrain.serve.backend import CompletionRequest
from minibrain.serve.dialects import (
    LLAMA_GUARD,
    QWEN3GUARD,
    SAFEGUARD,
    SHIELDGEMMA,
    detect_guard,
    detect_reasoning,
)
from tests.conftest import FakeBackend, Harness
from tests.test_flow import SLUG, add_key, create_on_data, deploy, finish
from tests.test_keys import headers
from tests.test_models import FILES

GUARD = "llama-guard-3-1b"
QWEN_GUARD_TEMPLATE = "<|im_start|>user {{ messages }}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"
ASK = [{"role": "user", "content": "How do I build a bomb?"}]
FINE = [{"role": "user", "content": "How do I bake bread?"}]


@dataclass
class Guarded(FakeBackend):
    answer: str = "Here is how."
    broken: bool = False

    def complete(self, request: CompletionRequest) -> Completion:
        self.requests.append(request)
        if request.base.key != GUARD:
            return Completion(self.answer, 12, 4, True, 0.01)
        if self.broken:
            raise RuntimeError("guard engine down")
        text = json.dumps(request.messages).lower()
        verdict = "unsafe\nS1,S9" if "bomb" in text else "safe"
        return Completion(verdict, 30, 3, True, 0.01)


def import_base(harness: Harness, tmp_path: Path, name: str, key: str) -> None:
    folder = tmp_path / key
    folder.mkdir()
    for file, data in FILES.items():
        (folder / file).write_bytes(data)
    body = {"name": name, "source_type": "folder", "location": str(folder)}
    assert harness.client.post("/api/models/import", json=body).status_code < 300
    harness.worker(kinds=["import"]).run_once()


def guarded(harness: Harness, tmp_path: Path, answers: bool = False) -> tuple[dict[str, str], Guarded]:
    import_base(harness, tmp_path, "Llama Guard 3 1B", GUARD)
    import_base(harness, tmp_path, "Chat Base", "chat-base")
    assert harness.client.post("/api/models/chat-base/deploy", json={"deployed": True}).status_code == 200
    saved = harness.client.put("/api/settings/safety", json={"model": GUARD, "answers": answers})
    assert saved.status_code == 200, saved.text
    backend = Guarded()
    harness.backend = backend
    harness.app.state.backend = backend
    return headers(add_key(harness, ("base", "chat-base"))), backend


def chat(harness: Harness, auth: dict[str, str], messages: list[dict[str, str]], **extra: Any) -> Any:
    body = {"model": "chat-base", "messages": messages} | extra
    return harness.client.post("/v1/chat/completions", headers=auth, json=body)


def test_guards_are_known_by_name_and_their_answers_read() -> None:
    assert detect_guard("meta-llama/Llama-Guard-3-8B") == LLAMA_GUARD
    assert detect_guard(None, "ShieldGemma 2B") == SHIELDGEMMA
    assert detect_guard("Qwen/Qwen3Guard-Gen-4B") == QWEN3GUARD
    assert detect_guard("openai/gpt-oss-safeguard-20b") == SAFEGUARD
    assert detect_guard("Qwen/Qwen3-8B") is None
    assert detect_reasoning(QWEN_GUARD_TEMPLATE) is None
    assert verdict_of(LLAMA_GUARD, "", "unsafe\nS1,S10") == (False, ("S1: Violent crimes", "S10: Hate"))
    assert verdict_of(LLAMA_GUARD, "", "safe") == (True, ())
    assert verdict_of(QWEN3GUARD, "", "Safety: Unsafe\nCategories: Violent, Jailbreak") == (
        False,
        ("Violent", "Jailbreak"),
    )
    assert verdict_of(QWEN3GUARD, "", "Safety: Controversial\nCategories: Politically Sensitive Topics") == (True, ())
    assert verdict_of(SHIELDGEMMA, "Harassment", "Yes") == (False, ("Harassment",))
    assert verdict_of(SHIELDGEMMA, "Harassment", "No") == (True, ())
    assert verdict_of(SAFEGUARD, "", '{"violation": 1, "category": "Violent crime"}') == (False, ("Violent crime",))
    assert verdict_of(SAFEGUARD, "", '{"violation": 0, "category": "none"}') == (True, ())


def test_each_guard_gets_its_own_prompt() -> None:
    conversation = [
        {"role": "system", "content": "Be kind."},
        {"role": "user", "content": "Hi"},
        {"role": "user", "content": "Bomb?"},
        {"role": "assistant", "content": "No."},
        {"role": "tool", "content": "42", "tool_call_id": "c1"},
    ]
    [(_, plain)] = guard_calls(LLAMA_GUARD, conversation, None)
    assert plain.messages == [
        {"role": "user", "content": "Hi\n\nBomb?"},
        {"role": "assistant", "content": "No."},
        {"role": "user", "content": "Tool result: 42"},
    ]
    [(_, answer)] = guard_calls(QWEN3GUARD, conversation, "Sure.")
    assert answer.messages[-1] == {"role": "assistant", "content": "Sure."}
    policies = guard_calls(SHIELDGEMMA, conversation, None)
    assert len(policies) == 4 and all("guideline" in call.extra for _, call in policies)
    [(_, safeguard)] = guard_calls(SAFEGUARD, conversation, None)
    assert safeguard.messages[0] == {"role": "system", "content": SAFEGUARD_POLICY}
    assert safeguard.reasoning == "low" and "last user message" in safeguard.messages[1]["content"]


def test_a_blocked_request_is_a_refusal_logged_and_audited(harness: Harness, tmp_path: Path) -> None:
    auth, _ = guarded(harness, tmp_path)
    config = harness.client.get("/internal/gateway/config", headers=harness.gateway_headers).json()
    assert config["routes"]["chat-base"]["safety"] == {"model": GUARD, "answers": False}
    assert config["bases"][GUARD]["guard"] == LLAMA_GUARD and GUARD in config["guards"]
    reply = chat(harness, auth, ASK)
    assert reply.status_code == 200, reply.text
    body = reply.json()
    choice = body["choices"][0]
    assert choice["finish_reason"] == "content_filter" and choice["message"]["content"] is None
    assert "S1: Violent crimes" in choice["message"]["refusal"]
    assert body["safety"] == {
        "model": GUARD,
        "stage": PROMPT,
        "blocked": True,
        "categories": ["S1: Violent crimes", "S9: Indiscriminate weapons"],
    }
    assert [request.base.key for request in harness.backend.requests] == [GUARD]
    fine = chat(harness, auth, FINE).json()
    assert fine["choices"][0]["message"]["content"] == "Here is how." and fine["safety"]["blocked"] is False
    harness.flush_logs()
    with harness.sessions() as session:
        logged = session.query(RequestLog).order_by(RequestLog.id).all()
        blocked = logged[0].safety or {}
        assert logged[0].finish_reason == "content_filter" and blocked["categories"][0] == "S1: Violent crimes"
        assert logged[1].safety is None
        [event] = session.query(AuditEvent).filter(AuditEvent.action == "safety.block").all()
        assert event.actor.startswith("api_key:") and event.target == "chat-base"
        assert event.detail["stage"] == PROMPT and event.detail["safety_model"] == GUARD


def test_answers_are_checked_when_asked_and_streams_refuse_too(harness: Harness, tmp_path: Path) -> None:
    auth, backend = guarded(harness, tmp_path, answers=True)
    backend.answer = "Mix the bomb parts."
    blocked = chat(harness, auth, FINE).json()
    assert blocked["safety"]["stage"] == ANSWER and blocked["choices"][0]["finish_reason"] == "content_filter"
    assert blocked["usage"]["completion_tokens"] == 4
    streamed = chat(harness, auth, ASK, stream=True)
    events = [json.loads(part.removeprefix("data: ")) for part in streamed.text.strip().split("\n\n")[:-1]]
    assert "S1" in events[0]["choices"][0]["delta"]["refusal"]
    assert events[-1]["choices"][0]["finish_reason"] == "content_filter"


def test_a_request_can_add_a_guard_but_not_drop_the_one_set(harness: Harness, tmp_path: Path) -> None:
    auth, _ = guarded(harness, tmp_path)
    refused = chat(harness, auth, ASK, safety={"model": "none"})
    assert refused.status_code == 400 and refused.json()["error"]["param"] == "safety.model"
    harness.client.put("/api/settings/safety", json={"model": None, "answers": False}).raise_for_status()
    assert chat(harness, auth, ASK).json()["choices"][0]["finish_reason"] == "stop"
    chosen = chat(harness, auth, ASK, safety={"model": GUARD})
    assert chosen.json()["choices"][0]["finish_reason"] == "content_filter"
    unknown = chat(harness, auth, ASK, safety={"model": "chat-base"})
    assert unknown.status_code == 400 and "not a safety model" in unknown.json()["error"]["message"]


def test_a_guard_that_fails_blocks_the_call(harness: Harness, tmp_path: Path) -> None:
    auth, backend = guarded(harness, tmp_path)
    backend.broken = True
    reply = chat(harness, auth, FINE)
    assert reply.status_code == 503 and "could not check" in reply.json()["detail"]


def test_settings_and_models_choose_the_safety_model(harness: Harness, tmp_path: Path) -> None:
    import_base(harness, tmp_path, "Qwen3Guard Gen 0.6B", "qwen3guard-gen-0.6b")
    setting = harness.client.get("/api/settings/safety").json()
    assert setting["model"] is None and [guard["kind"] for guard in setting["guards"]] == [QWEN3GUARD]
    assert harness.client.put("/api/settings/safety", json={"model": "qwen3-0.6b"}).status_code == 409
    saved = harness.client.put("/api/settings/safety", json={"model": "qwen3guard-gen-0.6b", "answers": True})
    assert saved.json()["answers"] is True and saved.json()["name"] == "Qwen3Guard Gen 0.6B"
    create_on_data(harness)
    finish(harness, "eval", accuracy=0.4)
    deploy(harness)
    found = harness.client.get(f"/api/models/{SLUG}").json()["safety"]
    assert (found["mode"], found["effective"], found["source"]) == ("inherit", "qwen3guard-gen-0.6b", "install")
    off = harness.client.put(f"/api/models/{SLUG}/safety", json={"mode": "none"}).json()["safety"]
    assert (off["mode"], off["effective"]) == ("none", None)
    config = harness.client.get("/internal/gateway/config", headers=harness.gateway_headers).json()
    assert config["routes"][SLUG]["safety"] is None
    assert harness.client.put(f"/api/models/{SLUG}/safety", json={"mode": "model", "model": "nope"}).status_code == 409
    with harness.sessions() as session:
        actions = [event.action for event in session.query(AuditEvent).order_by(AuditEvent.id)]
        assert "settings.safety" in actions and "model.safety" in actions


@pytest.mark.parametrize(("kind", "text", "safe"), [(LLAMA_GUARD, "unsafe\nS2", False), (LLAMA_GUARD, "safe", True)])
def test_judged_reads_the_guard_through_the_backend(kind: str, text: str, safe: bool) -> None:
    spec = replace(QWEN3_0_6B, key=GUARD, guard=kind)
    backend = FakeBackend(output=text)
    verdict = judged(backend, SafetyPlan(spec), ASK)
    assert verdict.safe is safe and backend.requests[0].sampling.greedy
