import io
import json
import struct
import sys
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, cast

import pytest
from fastapi.testclient import TestClient
from openai import OpenAI

from minibrain.base_models import QWEN3_0_6B, base_model
from minibrain.ml.completion import Completion, ToolCall
from minibrain.ml.runtime import render_prompt
from minibrain.models.templates import gguf_template, template_in_files
from minibrain.serve.backend import CompletionRequest, TransformersBackend, parsed
from minibrain.serve.dialects import (
    HARMONY,
    HERMES,
    LLAMA3,
    MISTRAL,
    ToolUse,
    detect_tools,
    prefill,
    read_all,
    reader_for,
    template_messages,
)
from minibrain.serve.engine import create_engine_app
from minibrain.serve.engines import EngineBackend
from minibrain.serve.sglang_backend import SglangBackend, launch_command
from minibrain.serve.vllm_backend import launch_command as vllm_command
from tests.conftest import FakeBackend, Harness
from tests.test_flow import add_key
from tests.test_gateway import servable
from tests.test_general import create_assistant
from tests.test_keys import headers
from tests.test_models import FILES

WEATHER = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "The weather in a city",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
    },
}
CLOCK = {"type": "function", "function": {"name": "get_time", "parameters": {"type": "object", "properties": {}}}}
NAMED = {"type": "function", "function": {"name": "get_weather"}}
QWEN_TEMPLATE = "{% for m in messages %}<|im_start|>{{ m.role }}{% endfor %}{% if tools %}<tool_call>{% endif %}"
LLAMA_TEMPLATE = '{% if tools %}Environment: ipython {"name": ..., "parameters": ...}<|python_tag|>{% endif %}'
QWEN_CALLS = (
    "Let me check.\n<tool_call>\n"
    '{"name": "get_weather", "arguments": {"city": "Paris"}}\n</tool_call>\n'
    '<tool_call>\n{"name": "get_time", "arguments": {}}\n</tool_call>'
)
LLAMA_CALL = '<|python_tag|>{"name": "get_weather", "parameters": {"city": "Paris"}}'
ASK = [{"role": "user", "content": "Weather in Paris?"}]
ASSISTANT = "assistant-1"


def use(*tools: dict[str, Any], choice: Any = None, parallel: bool = True) -> ToolUse:
    return ToolUse(tools or (WEATHER,), choice, parallel)


def read(fmt: str, text: str, tools: ToolUse | None = None) -> Any:
    return read_all(reader_for(fmt, tools or use()), text)


def chunked(fmt: str, text: str, size: int) -> Any:
    reader = reader_for(fmt, use())
    found = reader.feed(text[:size])
    for start in range(size, len(text), size):
        found += reader.feed(text[start : start + size])
    return found + reader.finish()


def loose(value: Any) -> Any:
    return value


def test_qwen_hermes_calls_are_read_from_the_answer() -> None:
    found = read(HERMES, QWEN_CALLS)
    assert found.content == "Let me check.\n"
    assert [(call.name, json.loads(call.arguments)) for call in found.tool_calls] == [
        ("get_weather", {"city": "Paris"}),
        ("get_time", {}),
    ]
    assert all(call.id.startswith("call_") for call in found.tool_calls)
    for size in (1, 3, 7):
        streamed = chunked(HERMES, QWEN_CALLS, size)
        assert streamed.content == found.content
        assert [call.name for call in streamed.tool_calls] == ["get_weather", "get_time"]
    assert read(HERMES, "<tool_call>\nnot json\n</tool_call>").content == "<tool_call>\nnot json\n</tool_call>"
    assert read(HERMES, '<tool_call>\n{"name": "get_time", "arguments": {}}').tool_calls[0].name == "get_time"
    assert read(HERMES, "Just text.").content == "Just text."
    assert len(read(HERMES, QWEN_CALLS, use(parallel=False)).tool_calls) == 1


def test_llama_json_calls_are_read_from_the_answer() -> None:
    found = read(LLAMA3, LLAMA_CALL)
    assert (found.content, found.tool_calls[0].name) == ("", "get_weather")
    assert json.loads(found.tool_calls[0].arguments) == {"city": "Paris"}
    two = read(
        LLAMA3, '{"name": "get_weather", "parameters": {"city": "Rome"}}; {"name": "get_time", "parameters": {}}'
    )
    assert [call.name for call in two.tool_calls] == ["get_weather", "get_time"]
    assert read(LLAMA3, "It is sunny.").content == "It is sunny."
    assert read(LLAMA3, '{"answer": 42}').content == '{"answer": 42}'
    assert chunked(LLAMA3, LLAMA_CALL, 2).tool_calls[0].name == "get_weather"


def test_mistral_and_harmony_calls_are_read_from_the_answer() -> None:
    found = read(MISTRAL, '[TOOL_CALLS] [{"name": "get_weather", "arguments": {"city": "Oslo"}}]')
    assert found.tool_calls[0].name == "get_weather" and len(found.tool_calls[0].id) == 9
    harmony = (
        "<|channel|>analysis<|message|>The user wants weather.<|end|><|start|>assistant"
        '<|channel|>commentary to=functions.get_weather <|constrain|>json<|message|>{"city": "Lima"}'
    )
    called = read(HARMONY, harmony)
    assert called.content == "" and called.tool_calls[0].name == "get_weather"
    assert json.loads(called.tool_calls[0].arguments) == {"city": "Lima"}
    final = read(HARMONY, "<|channel|>analysis<|message|>Easy.<|end|><|start|>assistant<|channel|>final<|message|>Hi!")
    assert (final.content, final.tool_calls) == ("Hi!", ())
    assert read(HARMONY, "plain words", ToolUse()).content == "plain words"


def test_required_and_named_choices_prefill_the_answer() -> None:
    assert prefill(HERMES, use(choice="auto")) == ""
    assert prefill(HERMES, use(choice="required")) == "<tool_call>\n"
    assert prefill(HERMES, use(choice=NAMED)) == '<tool_call>\n{"name": "get_weather", "arguments": '
    assert prefill(LLAMA3, use(choice=NAMED)) == '{"name": "get_weather", "parameters": '
    assert prefill(HARMONY, use(choice="required")) == "<|channel|>commentary to=functions."
    assert prefill(HERMES, use(choice="none")) == ""
    assert not use(choice="none").active and use().mode == "auto" and not ToolUse().active


def test_templates_say_which_format_a_model_uses() -> None:
    assert detect_tools(QWEN_TEMPLATE) == HERMES
    assert detect_tools(LLAMA_TEMPLATE) == LLAMA3
    assert detect_tools("[AVAILABLE_TOOLS] [TOOL_CALLS]") == MISTRAL
    assert detect_tools("<|start|>assistant<|channel|>final") == HARMONY
    assert detect_tools("<tool_call><arg_key>") is None
    assert detect_tools("{{ messages }}") is None and detect_tools(None) is None
    config = json.dumps({"chat_template": [{"name": "default", "template": QWEN_TEMPLATE}]}).encode()
    assert template_in_files({"tokenizer_config.json": config}.get) == QWEN_TEMPLATE
    assert template_in_files({"chat_template.jinja": b"jinja"}.get) == "jinja"


def gguf_text(value: str) -> bytes:
    return struct.pack("<Q", len(value.encode())) + value.encode()


def gguf(template: str) -> bytes:
    tokens = struct.pack("<I", 8) + struct.pack("<Q", 2) + gguf_text("a") + gguf_text("b")
    pairs = [
        gguf_text("general.architecture") + struct.pack("<I", 8) + gguf_text("qwen3"),
        gguf_text("tokenizer.ggml.tokens") + struct.pack("<I", 9) + tokens,
        gguf_text("qwen3.context_length") + struct.pack("<I", 4) + struct.pack("<I", 4096),
        gguf_text("tokenizer.chat_template") + struct.pack("<I", 8) + gguf_text(template),
    ]
    return b"GGUF" + struct.pack("<I", 3) + struct.pack("<Q", 0) + struct.pack("<Q", len(pairs)) + b"".join(pairs)


def test_gguf_metadata_gives_the_chat_template() -> None:
    assert gguf_template(io.BytesIO(gguf(QWEN_TEMPLATE))) == QWEN_TEMPLATE
    assert gguf_template(io.BytesIO(b"not a gguf")) is None
    assert gguf_template(io.BytesIO(gguf(QWEN_TEMPLATE)[:40])) is None


def test_messages_reach_templates_with_arguments_as_objects() -> None:
    call = {"id": "c1", "type": "function", "function": {"name": "get_weather", "arguments": '{"city": "Paris"}'}}
    messages = [*ASK, {"role": "assistant", "content": None, "tool_calls": [call]}]
    shown = template_messages(messages)
    assert shown[1]["content"] == "" and shown[1]["tool_calls"][0]["function"]["arguments"] == {"city": "Paris"}
    assert call["function"]["arguments"] == '{"city": "Paris"}'


@dataclass
class Recorder:
    calls: list[dict[str, Any]] = field(default_factory=list)

    def apply_chat_template(self, messages: Any, **kwargs: Any) -> str:
        self.calls.append({"messages": messages} | kwargs)
        return "PROMPT:"


@dataclass
class FakeRuntime:
    raw: str
    tokenizer: Recorder = field(default_factory=Recorder)
    prompts: list[str] = field(default_factory=list)

    def render(self, messages: list[dict[str, Any]], tools: Any = None, kwargs: Any = None) -> str:
        return render_prompt(cast(Any, self.tokenizer), QWEN3_0_6B, messages, tools, kwargs)

    def generate(self, prompts: list[str], *_args: Any) -> list[Completion]:
        self.prompts += prompts
        return [Completion(text=self.raw, prompt_tokens=5, completion_tokens=9, stopped=True, seconds=0.1)]


def test_transformers_renders_tools_and_reads_qwen_and_llama_calls() -> None:
    backend = TransformersBackend(lambda _artifact: Path())
    for fmt, raw in ((HERMES, QWEN_CALLS), (LLAMA3, LLAMA_CALL)):
        runtime = FakeRuntime(raw)
        spec = replace(QWEN3_0_6B, tools=fmt)
        cast(Any, backend.runtimes)[spec.key] = runtime
        request = CompletionRequest(spec, ASK, None, 64, tools=use(WEATHER, CLOCK))
        completion = backend.complete(request)
        assert completion.tool_calls[0].name == "get_weather" and completion.finish_reason == "tool_calls"
        assert runtime.tokenizer.calls[-1]["tools"] == [WEATHER, CLOCK]
        assert runtime.tokenizer.calls[-1]["enable_thinking"] is False
        backend.complete(replace(request, tools=use(WEATHER, choice=NAMED)))
        assert runtime.prompts[-1] == "PROMPT:" + prefill(fmt, use(WEATHER, choice=NAMED))
        backend.complete(replace(request, tools=use(WEATHER, choice="none")))
        assert runtime.tokenizer.calls[-1]["tools"] is None


@dataclass
class Scripted(FakeBackend):
    def complete(self, request: CompletionRequest) -> Completion:
        self.requests.append(request)
        raw = Completion(text=self.output, prompt_tokens=12, completion_tokens=9, stopped=True, seconds=0.01)
        return parsed(request, raw)


def tool_base(harness: Harness, tmp_path: Path, template: str, key: str = "tool-base") -> dict[str, str]:
    folder = tmp_path / key
    folder.mkdir()
    files = FILES | {"tokenizer_config.json": json.dumps({"chat_template": template}).encode()}
    for name, data in files.items():
        (folder / name).write_bytes(data)
    body = {"name": key.replace("-", " ").title(), "source_type": "folder", "location": str(folder)}
    assert harness.client.post("/api/base-models/import", json=body).status_code < 300
    harness.worker(kinds=["import"]).run_once()
    assert harness.client.post(f"/api/base-models/{key}/deploy", json={"deployed": True}).status_code == 200
    harness.backend = Scripted()
    harness.app.state.backend = harness.backend
    return headers(add_key(harness, ("base", key)))


def sdk(harness: Harness, auth: dict[str, str]) -> OpenAI:
    secret = auth["Authorization"].removeprefix("Bearer ")
    return OpenAI(base_url="http://testserver/v1", api_key=secret, http_client=harness.client)


def test_the_openai_sdk_calls_tools_and_sends_results_back(harness: Harness, tmp_path: Path) -> None:
    auth = tool_base(harness, tmp_path, QWEN_TEMPLATE)
    config = harness.client.get("/internal/gateway/config", headers=harness.gateway_headers).json()
    assert config["bases"]["tool-base"]["tools"] == HERMES
    client = sdk(harness, auth)
    harness.backend.output = QWEN_CALLS
    reply = client.chat.completions.create(model="tool-base", messages=loose(ASK), tools=loose([WEATHER, CLOCK]))
    choice = reply.choices[0]
    assert choice.finish_reason == "tool_calls" and choice.message.content == "Let me check.\n"
    calls = [loose(call) for call in choice.message.tool_calls or []]
    assert [call.function.name for call in calls] == ["get_weather", "get_time"]
    first = calls[0]
    harness.backend.output = "It is sunny in Paris."
    answered = {"role": "assistant", "content": None, "tool_calls": [first.model_dump()]}
    result = {"role": "tool", "tool_call_id": first.id, "content": '{"sky": "sunny"}'}
    follow = client.chat.completions.create(
        model="tool-base", messages=loose([*ASK, answered, result]), tools=loose([WEATHER]), tool_choice="auto"
    )
    assert follow.choices[0].message.content == "It is sunny in Paris."
    sent = harness.backend.requests[-1]
    assert [message["role"] for message in sent.messages] == ["user", "assistant", "tool"]
    assert sent.messages[2]["tool_call_id"] == first.id
    assert sent.messages[1]["tool_calls"][0]["function"]["name"] == "get_weather"
    harness.backend.output = QWEN_CALLS
    stream = client.chat.completions.create(model="tool-base", messages=loose(ASK), tools=loose([WEATHER]), stream=True)
    deltas = [chunk.choices[0] for chunk in stream if chunk.choices]
    streamed = [call for delta in deltas for call in delta.delta.tool_calls or []]
    assert [call.function.name for call in streamed if call.function] == ["get_weather", "get_time"]
    assert deltas[-1].finish_reason == "tool_calls"


def test_llama_bases_call_tools_through_the_gateway(harness: Harness, tmp_path: Path) -> None:
    auth = tool_base(harness, tmp_path, LLAMA_TEMPLATE, key="llama-base")
    harness.backend.output = '{"city": "Paris"}}'
    body = {"model": "llama-base", "messages": ASK, "tools": [WEATHER], "tool_choice": NAMED}
    reply = harness.client.post("/v1/chat/completions", headers=auth, json=body).json()
    message = reply["choices"][0]["message"]
    assert message["content"] is None and message["tool_calls"][0]["function"]["name"] == "get_weather"
    assert harness.backend.requests[-1].tools.function == "get_weather"


BAD_NAME = {"type": "function", "function": {"name": "bad name"}}
BAD_SCHEMA = {"type": "function", "function": {"name": "f", "parameters": {"type": "strng"}}}
IMAGE = {"role": "user", "content": [{"type": "image_url", "image_url": {}}]}


@pytest.mark.parametrize(
    ("extra", "param"),
    [
        ({"tool_choice": "auto"}, "tool_choice"),
        ({"tools": [WEATHER], "tool_choice": "sometimes"}, "tool_choice"),
        (
            {"tools": [WEATHER], "tool_choice": {"type": "function", "function": {"name": "no"}}},
            "tool_choice.function.name",
        ),
        ({"tools": [BAD_NAME]}, "tools[0].function.name"),
        ({"tools": [WEATHER, WEATHER]}, "tools[1].function.name"),
        ({"tools": [BAD_SCHEMA]}, "tools[0].function.parameters"),
        ({"messages": [{"role": "tool", "content": "x"}]}, "messages[0].tool_call_id"),
        ({"messages": [{"role": "robot", "content": "x"}]}, "messages[0].role"),
        ({"messages": [IMAGE]}, "messages[0].content[0]"),
        ({"functions": [{"name": "f"}]}, "functions"),
    ],
)
def test_malformed_tools_are_openai_400s(harness: Harness, tmp_path: Path, extra: dict[str, Any], param: str) -> None:
    auth = tool_base(harness, tmp_path, QWEN_TEMPLATE)
    body = {"model": "tool-base", "messages": ASK} | extra
    reply = harness.client.post("/v1/chat/completions", headers=auth, json=body)
    assert reply.status_code == 400, reply.text
    assert reply.json()["error"]["param"] == param


def test_tools_need_a_free_text_contract_and_a_known_format(harness: Harness, tmp_path: Path) -> None:
    labelled = servable(harness)
    body = {"model": "support-triage", "messages": ASK, "tools": [WEATHER]}
    refused = harness.client.post("/v1/chat/completions", headers=labelled, json=body)
    assert refused.status_code == 400 and "takes no tools" in refused.json()["error"]["message"]
    plain = tool_base(harness, tmp_path, "{{ messages }}", key="plain-base")
    unknown = harness.client.post("/v1/chat/completions", headers=plain, json=body | {"model": "plain-base"})
    assert unknown.status_code == 400 and "no tool-call format" in unknown.json()["error"]["message"]
    text_parts = {"model": "plain-base", "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}]}
    assert harness.client.post("/v1/chat/completions", headers=plain, json=text_parts).status_code == 200
    assert harness.backend.requests[-1].messages[-1]["content"] == "hi"


def test_custom_free_text_models_keep_tool_turns(harness: Harness) -> None:
    create_assistant(harness)
    auth = headers(add_key(harness, ("custom", ASSISTANT)))
    harness.backend.output = "done"
    call = {"id": "c1", "type": "function", "function": {"name": "get_weather", "arguments": "{}"}}
    system = {"role": "system", "content": "ignored"}
    answered = {"role": "assistant", "content": None, "tool_calls": [call]}
    result = {"role": "tool", "tool_call_id": "c1", "content": "sunny"}
    body = {"model": f"{ASSISTANT}@0", "messages": [system, *ASK, answered, result], "tools": [WEATHER]}
    assert harness.client.post("/v1/chat/completions", headers=auth, json=body).status_code == 200
    sent = harness.backend.requests[-1].messages
    assert [message["role"] for message in sent][-3:] == ["user", "assistant", "tool"]
    assert "ignored" not in json.dumps(sent)


CALLED = Completion("", 3, 4, True, 0.1, tool_calls=(ToolCall("get_weather", "{}", "call_1"),))


@dataclass
class Calling(FakeBackend):
    called: Completion = CALLED

    def complete(self, request: CompletionRequest) -> Completion:
        self.requests.append(request)
        return self.called


def test_engines_carry_tools_and_return_calls(harness: Harness, tmp_path: Path) -> None:
    fake = Calling()
    key = base_model("qwen3-0.6b")
    app = create_engine_app(key, "http://main", "t", tmp_path / "e", backend=fake, http=harness.client)
    with TestClient(app) as engine:
        backend = EngineBackend(lambda: {"qwen3-0.6b": [{"url": "http://testserver", "state": "ready"}]}, http=engine)
        request = CompletionRequest(key, ASK, None, 8, tools=use(choice="required", parallel=False))
        assert backend.complete(request) == fake.called
    assert fake.requests[-1].tools == use(choice="required", parallel=False)


def test_sglang_and_vllm_parse_tool_calls_natively(tmp_path: Path) -> None:
    spec = replace(QWEN3_0_6B, path=str(tmp_path))
    (tmp_path / "config.json").write_text("{}")
    assert launch_command(spec, 1)[-4:-2] == ["--tool-call-parser", "qwen25"]
    flags = vllm_command(replace(spec, tools=LLAMA3, reasoning=None), 1)[-3:]
    assert flags == ["--enable-auto-tool-choice", "--tool-call-parser", "llama3_json"]
    assert "--tool-call-parser" not in launch_command(replace(spec, tools=None), 1)
    log = tmp_path / "requests.jsonl"
    script = Path(__file__).parent / "fake_sglang.py"
    backend = SglangBackend(
        lambda _artifact: tmp_path,
        command=lambda _spec, port: [sys.executable, str(script), "--port", str(port), "--log", str(log)],
        startup_seconds=30,
    )
    try:
        completion = backend.complete(CompletionRequest(QWEN3_0_6B, ASK, None, 8, tools=use(choice="required")))
        plain = backend.complete(CompletionRequest(QWEN3_0_6B, ASK, None, 8, tools=use(choice="none")))
    finally:
        backend.close()
    assert completion.tool_calls == (ToolCall("get_weather", '{"city": "Paris"}', "call_fake"),)
    assert completion.finish_reason == "tool_calls" and plain.tool_calls == ()
    bodies = [json.loads(line)["body"] for line in log.read_text().splitlines()]
    assert bodies[0]["tools"] == [WEATHER] and bodies[0]["tool_choice"] == "required"
    assert bodies[0]["parallel_tool_calls"] is True and bodies[1]["tool_choice"] == "none"
