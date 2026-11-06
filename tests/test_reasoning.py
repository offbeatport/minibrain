import json
import sys
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from minibrain.base_models import QWEN3_0_6B
from minibrain.serve.backend import CompletionRequest
from minibrain.serve.dialects import (
    ALWAYS,
    EFFORT,
    HARMONY,
    OPEN,
    TAGS,
    TOGGLE,
    ToolUse,
    answer_text,
    detect_reasoning,
    read_all,
    reader_for,
    reasoning_choices,
    reasoning_kwargs,
    think_mode,
)
from minibrain.serve.sglang_backend import SglangBackend, launch_command
from minibrain.serve.vllm_backend import launch_command as vllm_command
from tests.conftest import Harness
from tests.test_gateway import servable
from tests.test_tools import ASK, QWEN_TEMPLATE, tool_base

THINKING_TEMPLATE = QWEN_TEMPLATE + "{% if enable_thinking is defined and enable_thinking is false %}{% endif %}"
GPT_OSS_TEMPLATE = "<|start|>assistant<|channel|>final {{ reasoning_effort }}"
R1_TEMPLATE = "{% if add_generation_prompt %}{{'<\uff5cAssistant\uff5c><think>\\n'}}{% endif %}"
THOUGHT = "<think>\nThe user greets me.\n</think>\n\nHello there."


def chat(harness: Harness, auth: dict[str, str], model: str, **extra: Any) -> Any:
    return harness.client.post("/v1/chat/completions", headers=auth, json={"model": model, "messages": ASK} | extra)


def test_templates_say_how_a_model_reasons() -> None:
    assert detect_reasoning(THINKING_TEMPLATE) == TOGGLE
    assert detect_reasoning(GPT_OSS_TEMPLATE) == EFFORT
    assert detect_reasoning(R1_TEMPLATE) == ALWAYS
    assert detect_reasoning("'<|im_start|>assistant\\n<think>\\n'") == ALWAYS
    assert detect_reasoning(QWEN_TEMPLATE) is None and detect_reasoning(None) is None
    assert reasoning_choices(TOGGLE) == ("none", "low", "medium", "high")
    assert reasoning_choices(EFFORT) == ("low", "medium", "high") and reasoning_choices(ALWAYS) == ()
    assert reasoning_kwargs(TOGGLE, "none") == {"enable_thinking": False}
    assert reasoning_kwargs(TOGGLE, "low") == {"enable_thinking": True}
    assert reasoning_kwargs(EFFORT, "high") == {"reasoning_effort": "high"}
    assert reasoning_kwargs(TOGGLE, None) == {} and reasoning_kwargs(None, "high") == {}
    assert think_mode(TOGGLE, {}) == TAGS and think_mode(TOGGLE, {"enable_thinking": False}) is None
    assert think_mode(ALWAYS, {}) == OPEN and think_mode(EFFORT, {}) is None


def think(text: str, mode: str = TAGS, size: int = 0) -> Any:
    reader = reader_for(None, ToolUse(), mode)
    if not size:
        return read_all(reader, text)
    found = reader.feed(text[:size])
    for start in range(size, len(text), size):
        found += reader.feed(text[start : start + size])
    return found + reader.finish()


def test_think_tags_split_reasoning_from_the_answer() -> None:
    whole = think(THOUGHT)
    assert (whole.reasoning.strip(), whole.content) == ("The user greets me.", "Hello there.")
    for size in (1, 2, 5):
        part = think(THOUGHT, size=size)
        assert (part.reasoning.strip(), part.content) == ("The user greets me.", "Hello there.")
    assert think("Just an answer.").content == "Just an answer."
    cut = think("<think>still going")
    assert (cut.reasoning, cut.content) == ("still going", "")
    opened = think("Planning.\n</think>\nDone.", OPEN)
    assert (opened.reasoning.strip(), opened.content) == ("Planning.", "Done.")
    assert think("<think>x</think>y", OPEN).content == "y"
    tools = read_all(
        reader_for("hermes", ToolUse(({"type": "function", "function": {"name": "f"}},)), TAGS),
        '<think>call f</think>\n<tool_call>\n{"name": "f", "arguments": {}}\n</tool_call>',
    )
    assert (tools.reasoning, tools.tool_calls[0].name, tools.content) == ("call f", "f", "")


def test_harmony_analysis_is_reasoning_and_final_is_the_answer() -> None:
    text = "<|channel|>analysis<|message|>Think first.<|end|><|start|>assistant<|channel|>final<|message|>Answer."
    found = read_all(reader_for(HARMONY, ToolUse()), text)
    assert (found.reasoning, found.content) == ("Think first.", "Answer.")


def test_graders_see_the_answer_without_reasoning() -> None:
    assert answer_text(replace(QWEN3_0_6B, reasoning=ALWAYS), "Plan.</think>billing") == "billing"
    assert answer_text(QWEN3_0_6B, "billing") == "billing"
    harmony = replace(QWEN3_0_6B, tools=HARMONY, reasoning=EFFORT)
    assert answer_text(harmony, "<|channel|>analysis<|message|>x<|end|><|channel|>final<|message|>bug") == "bug"


def test_reasoning_comes_back_apart_from_the_answer(harness: Harness, tmp_path: Path) -> None:
    auth = tool_base(harness, tmp_path, THINKING_TEMPLATE, key="thinker")
    config = harness.client.get("/internal/gateway/config", headers=harness.gateway_headers).json()
    assert config["bases"]["thinker"]["reasoning"] == TOGGLE
    harness.backend.output = THOUGHT
    reply = chat(harness, auth, "thinker", reasoning_effort="high").json()
    message = reply["choices"][0]["message"]
    assert (message["content"], message["reasoning_content"]) == ("Hello there.", "The user greets me.")
    sent = harness.backend.requests[-1]
    assert sent.reasoning == "high" and sent.template_kwargs()["enable_thinking"] is True
    harness.backend.output = "Hello there."
    off = chat(harness, auth, "thinker", reasoning_effort="none").json()["choices"][0]["message"]
    assert off["content"] == "Hello there." and "reasoning_content" not in off
    assert harness.backend.requests[-1].template_kwargs()["enable_thinking"] is False
    harness.backend.output = THOUGHT
    streamed = harness.client.post(
        "/v1/chat/completions", headers=auth, json={"model": "thinker", "messages": ASK, "stream": True}
    )
    first = json.loads(streamed.text.split("\n\n")[0].removeprefix("data: "))
    assert first["choices"][0]["delta"]["reasoning_content"] == "The user greets me."
    assert first["choices"][0]["delta"]["content"] == "Hello there."


@pytest.mark.parametrize(
    ("template", "effort", "message"),
    [
        (QWEN_TEMPLATE, "high", "does not reason"),
        (GPT_OSS_TEMPLATE, "none", "always reasons; set reasoning_effort"),
        (R1_TEMPLATE, "low", "takes no effort"),
    ],
)
def test_reasoning_a_model_cannot_do_is_a_400(
    harness: Harness, tmp_path: Path, template: str, effort: str, message: str
) -> None:
    auth = tool_base(harness, tmp_path, template, key="reasoner")
    refused = chat(harness, auth, "reasoner", reasoning_effort=effort)
    assert refused.status_code == 400, refused.text
    error = refused.json()["error"]
    assert error["param"] == "reasoning_effort" and message in error["message"]
    assert chat(harness, auth, "reasoner").status_code == 200


def test_label_models_do_not_reason_and_none_is_always_accepted(harness: Harness, tmp_path: Path) -> None:
    labelled = servable(harness)
    assert chat(harness, labelled, "support-triage", reasoning_effort="none").status_code == 200
    refused = chat(harness, labelled, "support-triage", reasoning_effort="medium")
    assert refused.status_code == 400 and "does not reason" in refused.json()["error"]["message"]
    plain = tool_base(harness, tmp_path, QWEN_TEMPLATE, key="plain")
    assert chat(harness, plain, "plain", reasoning_effort="none").status_code == 200
    assert harness.backend.requests[-1].reasoning is None


def test_sglang_and_vllm_parse_reasoning_natively(tmp_path: Path) -> None:
    spec = replace(QWEN3_0_6B, path=str(tmp_path))
    (tmp_path / "config.json").write_text("{}")
    assert launch_command(spec, 1)[-2:] == ["--reasoning-parser", "qwen3"]
    gpt_oss = replace(spec, tools=HARMONY, reasoning=EFFORT)
    assert vllm_command(gpt_oss, 1)[-5:] == [
        "--enable-auto-tool-choice",
        "--tool-call-parser",
        "openai",
        "--reasoning-parser",
        "openai_gptoss",
    ]
    assert launch_command(replace(spec, reasoning=ALWAYS), 1)[-2:] == ["--reasoning-parser", "deepseek-r1"]
    log = tmp_path / "requests.jsonl"
    script = Path(__file__).parent / "fake_sglang.py"
    backend = SglangBackend(
        lambda _artifact: tmp_path,
        command=lambda _spec, port: [sys.executable, str(script), "--port", str(port), "--log", str(log)],
        startup_seconds=30,
    )
    try:
        thought = backend.complete(CompletionRequest(QWEN3_0_6B, ASK, None, 8, reasoning="high"))
        quiet = backend.complete(CompletionRequest(QWEN3_0_6B, ASK, None, 8))
        effort = backend.complete(
            CompletionRequest(replace(QWEN3_0_6B, tools=HARMONY, reasoning=EFFORT), ASK, None, 8, reasoning="low")
        )
    finally:
        backend.close()
    assert (thought.reasoning, quiet.reasoning, effort.reasoning) == ("thought:on", None, "thought:low")
    bodies = [json.loads(line)["body"] for line in log.read_text().splitlines()]
    assert bodies[0]["chat_template_kwargs"] == {"enable_thinking": True} and bodies[0]["separate_reasoning"] is True
    assert bodies[1]["chat_template_kwargs"] == {"enable_thinking": False}
    assert bodies[2]["reasoning_effort"] == "low"
