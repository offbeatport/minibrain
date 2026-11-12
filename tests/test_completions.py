import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient

from minibrain.base_models import QWEN3_0_6B, base_model
from minibrain.ml.completion import Completion, Piece
from minibrain.registry.models import RequestLog
from minibrain.serve.backend import CompletionRequest, drained, parsed, with_bos
from minibrain.serve.engine import create_engine_app
from minibrain.serve.engines import EngineBackend
from minibrain.serve.llamacpp_backend import LlamaCppBackend
from minibrain.serve.sglang_backend import SglangBackend
from tests.conftest import FakeBackend, Harness
from tests.test_flow import SLUG, add_key, add_version, create_with_dataset, deploy, finish
from tests.test_keys import headers
from tests.test_policies import set_policy
from tests.test_safety import ASK, FINE, GUARD, guarded, import_base
from tests.test_streaming import Streaming
from tests.test_tools import sdk

BASE = "chat-base"
CODE = "def fibonacci(n):"


def served_base(harness: Harness, tmp_path: Path) -> dict[str, str]:
    import_base(harness, tmp_path, "Chat Base", BASE)
    assert harness.client.post(f"/api/base-models/{BASE}/deploy", json={"deployed": True}).status_code == 200
    return headers(add_key(harness, ("base", BASE)))


def complete(harness: Harness, auth: dict[str, str], **body: Any) -> Any:
    return harness.client.post("/v1/completions", headers=auth, json={"model": BASE, "prompt": CODE} | body)


def events_of(text: str) -> list[Any]:
    parts = [part.removeprefix("data: ") for part in text.strip().split("\n\n")]
    assert parts[-1] == "[DONE]"
    return [json.loads(part) for part in parts[:-1]]


def test_a_base_model_continues_the_prompt_without_its_chat_template(harness: Harness, tmp_path: Path) -> None:
    auth = served_base(harness, tmp_path)
    harness.backend.output = "\n    return n"
    reply = complete(harness, auth, max_tokens=32, temperature=0.7, top_p=0.9, seed=7, user="ide")
    assert reply.status_code == 200, reply.text
    body = reply.json()
    assert body["object"] == "text_completion" and body["id"].startswith("cmpl-") and body["model"] == BASE
    assert body["choices"] == [{"index": 0, "text": "\n    return n", "logprobs": None, "finish_reason": "stop"}]
    assert body["usage"] == {"prompt_tokens": 12, "completion_tokens": 2, "total_tokens": 14}
    sent = harness.backend.requests[-1]
    assert (sent.prompt, sent.messages, sent.adapter, sent.constraint) == (CODE, [], None, None)
    assert (sent.max_tokens, sent.sampling.temperature, sent.sampling.top_p, sent.sampling.seed) == (32, 0.7, 0.9, 7)
    listed = complete(harness, auth, prompt=[CODE])
    assert listed.status_code == 200 and harness.backend.requests[-1].prompt == CODE
    assert harness.backend.requests[-1].max_tokens == 16


def test_stop_sequences_and_length_reach_the_engine(harness: Harness, tmp_path: Path) -> None:
    auth = served_base(harness, tmp_path)
    harness.backend.stopped = False
    reply = complete(harness, auth, stop=["\n\n", "def "]).json()
    assert reply["choices"][0]["finish_reason"] == "length"
    assert harness.backend.requests[-1].sampling.stop == ("\n\n", "def ")
    one = complete(harness, auth, stop="\n")
    assert one.status_code == 200 and harness.backend.requests[-1].sampling.stop == ("\n",)
    many = complete(harness, auth, stop=["a", "b", "c", "d", "e"])
    assert many.status_code == 400 and many.json()["error"]["param"] == "stop"


@pytest.mark.parametrize(
    ("field", "value", "param"),
    [
        ("prompt", ["one", "two"], "prompt"),
        ("prompt", [], "prompt"),
        ("prompt", [1, 2, 3], "prompt"),
        ("logprobs", 1, "logprobs"),
        ("echo", True, "echo"),
        ("suffix", "\n", "suffix"),
        ("n", 2, "n"),
        ("best_of", 3, "best_of"),
        ("logit_bias", {"50256": -100}, "logit_bias"),
        ("temperature", 3, "temperature"),
    ],
)
def test_unsupported_and_invalid_fields_are_openai_errors(
    harness: Harness, tmp_path: Path, field: str, value: Any, param: str
) -> None:
    auth = served_base(harness, tmp_path)
    reply = complete(harness, auth, **{field: value})
    assert reply.status_code == 400, reply.text
    error = reply.json()["error"]
    assert error["param"] == param and error["type"] == "invalid_request_error" and error["message"]
    assert harness.backend.requests == []


def test_a_list_of_prompts_is_refused_clearly(harness: Harness, tmp_path: Path) -> None:
    auth = served_base(harness, tmp_path)
    error = complete(harness, auth, prompt=["one", "two"]).json()["error"]
    assert "one text per request" in error["message"] and error["code"] == "unsupported_value"
    assert "token ids" in complete(harness, auth, prompt=[[1, 2]]).json()["error"]["message"]


def test_completions_stream_text_chunks_and_usage(harness: Harness, tmp_path: Path) -> None:
    auth = served_base(harness, tmp_path)
    harness.backend = Streaming(chunks=["\n    ", "return", " n"])
    harness.app.state.backend = harness.backend
    reply = complete(harness, auth, stream=True)
    assert reply.headers["content-type"].startswith("text/event-stream")
    events = events_of(reply.text)
    assert {event["object"] for event in events} == {"text_completion"}
    assert "".join(event["choices"][0]["text"] for event in events) == "\n    return n"
    assert events[-1]["choices"][0]["finish_reason"] == "stop" and events[-1]["usage"]["completion_tokens"] == 3
    with_usage = events_of(complete(harness, auth, stream=True, stream_options={"include_usage": True}).text)
    assert with_usage[-1]["choices"] == [] and with_usage[-1]["usage"]["total_tokens"] == 7
    client = sdk(harness, auth)
    parts = [chunk.choices[0].text for chunk in client.completions.create(model=BASE, prompt=CODE, stream=True)]
    assert "".join(parts) == "\n    return n"
    whole = client.completions.create(model=BASE, prompt=CODE)
    assert whole.choices[0].text == "\n    return n" and whole.usage is not None


def test_a_custom_model_applies_its_adapter_but_not_its_instructions(harness: Harness) -> None:
    create_with_dataset(harness)
    add_version(harness, "prompt")
    finish(harness, "eval", accuracy=0.4)
    add_version(harness, "lora")
    finish(harness, "train")
    finish(harness, "eval", accuracy=0.9)
    deploy(harness, 2)
    auth = headers(add_key(harness))
    harness.backend.output = "a refund."
    reply = harness.client.post("/v1/completions", headers=auth, json={"model": SLUG, "prompt": "I want"})
    assert reply.status_code == 200, reply.text
    assert reply.json()["choices"][0]["text"] == "a refund."
    sent = harness.backend.requests[-1]
    assert sent.adapter is not None and sent.adapter.name == f"{SLUG}-v2"
    assert (sent.prompt, sent.messages, sent.constraint) == ("I want", [], None)
    assert sent.sampling.temperature == 0
    pinned = harness.client.post("/v1/completions", headers=auth, json={"model": f"{SLUG}@1", "prompt": "x"})
    assert pinned.status_code == 200 and harness.backend.requests[-1].adapter is None
    assert harness.backend.requests[-1].prompt == "x"


def test_keys_cover_completions_like_chat(harness: Harness, tmp_path: Path) -> None:
    served_base(harness, tmp_path)
    create_with_dataset(harness)
    narrow = headers(add_key(harness))
    refused = complete(harness, narrow)
    assert refused.status_code == 403 and BASE in refused.json()["detail"]
    assert complete(harness, narrow, model="nope").status_code == 404
    assert harness.client.post("/v1/completions", json={"model": BASE, "prompt": CODE}).status_code == 401


def test_completions_are_logged_apart_from_chat(harness: Harness, tmp_path: Path) -> None:
    auth = served_base(harness, tmp_path)
    assert complete(harness, auth).status_code == 200
    chat = {"model": BASE, "messages": [{"role": "user", "content": "hi"}]}
    assert harness.client.post("/v1/chat/completions", headers=auth, json=chat).status_code == 200
    assert complete(harness, auth, echo=True).status_code == 400
    harness.flush_logs()
    with harness.sessions() as session:
        logs = session.query(RequestLog).order_by(RequestLog.id).all()
        assert [(log.kind, log.status) for log in logs] == [("completion", 200), ("chat", 200), ("completion", 400)]
        assert logs[0].response_id is not None and logs[0].response_id.startswith("cmpl-")
        assert logs[0].input is None and logs[0].finish_reason == "stop"
    items = harness.client.get("/api/requests").json()["items"]
    assert sorted(item["kind"] for item in items) == ["chat", "completion", "completion"]
    found = harness.client.get(f"/api/requests?q={logs[0].response_id}").json()["items"]
    assert [item["id"] for item in found] == [logs[0].id]


def test_kept_prompts_and_answers_are_logged(harness: Harness, tmp_path: Path) -> None:
    assert set_policy(harness, "request_bodies", True) == 200
    auth = served_base(harness, tmp_path)
    assert complete(harness, auth).status_code == 200
    harness.flush_logs()
    with harness.sessions() as session:
        logged = session.query(RequestLog).order_by(RequestLog.id).all()[-1]
        assert (logged.kind, logged.input, logged.output) == ("completion", CODE, "billing")


def test_the_safety_model_checks_the_prompt_and_the_text(harness: Harness, tmp_path: Path) -> None:
    auth, backend = guarded(harness, tmp_path, answers=True)
    blocked = harness.client.post("/v1/completions", headers=auth, json={"model": BASE, "prompt": ASK[0]["content"]})
    body = blocked.json()
    assert blocked.status_code == 200 and body["choices"][0] == {
        "index": 0,
        "text": "",
        "logprobs": None,
        "finish_reason": "content_filter",
    }
    assert body["safety"]["blocked"] is True and "S1: Violent crimes" in body["safety"]["categories"]
    assert [request.base.key for request in backend.requests] == [GUARD]
    backend.answer = "Mix the bomb parts."
    answered = harness.client.post(
        "/v1/completions", headers=auth, json={"model": BASE, "prompt": FINE[0]["content"], "stream": True}
    )
    events = events_of(answered.text)
    assert events[-1]["choices"][0]["finish_reason"] == "content_filter"
    assert "bomb" not in answered.text
    harness.flush_logs()
    with harness.sessions() as session:
        logs = session.query(RequestLog).order_by(RequestLog.id).all()
        assert [(log.kind, log.finish_reason) for log in logs] == [("completion", "content_filter")] * 2


def test_raw_prompts_skip_the_chat_template_on_every_engine() -> None:
    request = CompletionRequest(QWEN3_0_6B, [], None, 8, prompt=CODE)
    assert request.raw and request.prefill() == ""
    assert with_bos("<s>", CODE) == f"<s>{CODE}" and with_bos("<s>", f"<s>{CODE}") == f"<s>{CODE}"
    assert with_bos(None, CODE) == CODE
    assert LlamaCppBackend().render(SimpleNamespace(), request) == CODE
    answer = parsed(request, Completion("<think>x</think>y", 1, 1, True, 0.0))
    assert (answer.text, answer.reasoning, answer.tool_calls) == ("<think>x</think>y", None, ())


def test_engines_carry_the_prompt_over_their_api(harness: Harness, tmp_path: Path) -> None:
    fake = FakeBackend(output="    return n")
    spec = base_model("qwen3-0.6b")
    app = create_engine_app(spec, "http://main", "t", tmp_path / "engine", backend=fake, http=harness.client)
    with TestClient(app) as engine:
        backend = EngineBackend(lambda: {"qwen3-0.6b": [{"url": "http://testserver", "state": "ready"}]}, http=engine)
        assert backend.complete(CompletionRequest(spec, [], None, 8, prompt=CODE)).text == "    return n"
    assert (fake.requests[-1].prompt, fake.requests[-1].messages) == (CODE, [])


def test_sglang_and_vllm_use_their_completions_endpoint(tmp_path: Path) -> None:
    log = tmp_path / "requests.jsonl"
    script = Path(__file__).parent / "fake_sglang.py"
    backend = SglangBackend(
        lambda _artifact: tmp_path,
        command=lambda _spec, port: [sys.executable, str(script), "--port", str(port), "--log", str(log)],
        startup_seconds=30,
    )
    request = CompletionRequest(QWEN3_0_6B, [], None, 8, prompt=CODE)
    try:
        whole = backend.complete(request)
        streamed = list(backend.stream(request))
    finally:
        backend.close()
    assert (whole.text, whole.stopped, whole.prompt_tokens) == (f"base:{CODE}", False, 5)
    final = drained(iter(streamed))
    assert final.text == f"base:{CODE}" and len([event for event in streamed if isinstance(event, Piece)]) > 3
    sent = [json.loads(line) for line in log.read_text().splitlines()]
    assert {entry["path"] for entry in sent} == {"/v1/completions"}
    body = sent[0]["body"]
    assert body["prompt"] == CODE and "messages" not in body and "chat_template_kwargs" not in body
    assert "separate_reasoning" not in body


def test_the_api_reference_documents_completions(harness: Harness) -> None:
    document = harness.client.get("/api/openapi/v1.json").json()
    operation = document["paths"]["/completions"]["post"]
    assert operation["summary"] == "Create a text completion" and "chat template" in operation["description"]
    assert "TextCompletion" in document["components"]["schemas"] and "/completions" in document["info"]["description"]
