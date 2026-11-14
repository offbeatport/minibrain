import json
import sys
import time
from collections.abc import Generator, Iterator
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import cast

from fastapi.testclient import TestClient

from minibrain.base_models import QWEN3_0_6B, base_model
from minibrain.gateway.chat import sse
from minibrain.gateway.config import Grant
from minibrain.gateway.logs import LogBuffer, LogEntry
from minibrain.gateway.routes import CHAT, Outcome, log_call
from minibrain.gateway.schema import ChatCompletionRequest
from minibrain.ml.completion import Completion, Piece
from minibrain.registry.models import RequestLog
from minibrain.serve.backend import CompletionRequest, EngineUnavailableError, Event, drained, streamed
from minibrain.serve.dialects import HERMES, TOGGLE, ToolUse
from minibrain.serve.engine import create_engine_app
from minibrain.serve.engines import EngineBackend
from minibrain.serve.sampling import StopCutter
from minibrain.serve.sglang_backend import SglangBackend
from tests.conftest import FakeBackend, Harness
from tests.test_reasoning import THINKING_TEMPLATE
from tests.test_tools import ASK, QWEN_CALLS, WEATHER, loose, sdk, tool_base

RAW = ["<thi", "nk>\nPlan", " it.\n</th", "ink>\n\nHel", "lo ", "there."]


def raw_chunks(chunks: list[str]) -> Iterator[str | Completion]:
    yield from chunks
    yield Completion("".join(chunks), 4, len(chunks), True, 0.2)


@dataclass
class Streaming(FakeBackend):
    chunks: list[str] = field(default_factory=lambda: list(RAW))
    fail_after: int | None = None

    def complete(self, request: CompletionRequest) -> Completion:
        return drained(self.stream(request))

    def stream(self, request: CompletionRequest) -> Iterator[Event]:
        self.requests.append(request)
        for index, event in enumerate(streamed(request, raw_chunks(self.chunks))):
            if self.fail_after is not None and index >= self.fail_after:
                raise EngineUnavailableError("the engine went away")
            yield event


def test_stop_texts_are_cut_even_when_they_arrive_in_pieces() -> None:
    cutter = StopCutter(("<|im_end|>", "END"))
    out = [cutter.feed(part) for part in ("Hello <|im", "_end|> ignored")]
    assert "".join(out) + cutter.finish() == "Hello " and cutter.stopped
    plain = StopCutter(("END",))
    assert plain.feed("E") == "" and plain.feed("x") == "Ex" and plain.finish() == ""


def test_raw_chunks_become_reasoning_content_and_calls_as_they_arrive() -> None:
    spec = replace(QWEN3_0_6B, template_kwargs={}, reasoning=TOGGLE, tools=HERMES)
    request = CompletionRequest(spec, ASK, None, 32)
    events = list(streamed(request, raw_chunks(RAW)))
    pieces = [event for event in events if isinstance(event, Piece)]
    assert "".join(piece.reasoning for piece in pieces).strip() == "Plan it."
    assert "".join(piece.content for piece in pieces) == "Hello there."
    assert len([piece for piece in pieces if piece.content]) >= 2
    final = drained(iter(events))
    assert (final.text, final.reasoning, final.completion_tokens) == ("Hello there.", "Plan it.", len(RAW))
    calls = CompletionRequest(spec, ASK, None, 32, tools=ToolUse((WEATHER,)))
    chunks = [QWEN_CALLS[index : index + 4] for index in range(0, len(QWEN_CALLS), 4)]
    called = drained(streamed(calls, raw_chunks(chunks)))
    assert [call.name for call in called.tool_calls] == ["get_weather", "get_time"]


def test_the_sdk_streams_tokens_reasoning_and_usage(harness: Harness, tmp_path: Path) -> None:
    auth = tool_base(harness, tmp_path, THINKING_TEMPLATE, key="streamer")
    harness.backend = Streaming()
    harness.app.state.backend = harness.backend
    client = sdk(harness, auth)
    stream = client.chat.completions.create(
        model="streamer", messages=loose(ASK), stream=True, stream_options={"include_usage": True}
    )
    chunks = list(stream)
    deltas = [chunk.choices[0].delta for chunk in chunks if chunk.choices]
    content = [delta.content for delta in deltas if delta.content]
    reasoning = [loose(delta).reasoning_content for delta in deltas if getattr(delta, "reasoning_content", None)]
    assert "".join(content) == "Hello there." and len(content) >= 2
    assert "".join(reasoning).strip() == "Plan it."
    assert chunks[-1].choices == [] and chunks[-1].usage is not None and chunks[-1].usage.completion_tokens == 6
    finishes = [chunk.choices[0].finish_reason for chunk in chunks if chunk.choices]
    assert finishes[-1] == "stop"
    harness.flush_logs()
    with harness.sessions() as session:
        logged = session.query(RequestLog).order_by(RequestLog.id).all()[-1]
        assert (logged.status, logged.completion_tokens, logged.finish_reason) == (200, 6, "stop")


def test_a_failure_in_the_middle_of_a_stream_ends_it_with_an_error(harness: Harness, tmp_path: Path) -> None:
    auth = tool_base(harness, tmp_path, THINKING_TEMPLATE, key="flaky")
    harness.backend = Streaming(fail_after=2)
    harness.app.state.backend = harness.backend
    body = {"model": "flaky", "messages": ASK, "stream": True}
    reply = harness.client.post("/v1/chat/completions", headers=auth, json=body)
    assert reply.status_code == 200
    events = [part.removeprefix("data: ") for part in reply.text.strip().split("\n\n")]
    assert events[-1] == "[DONE]"
    assert "the engine went away" in json.loads(events[-2])["error"]["message"]
    harness.flush_logs()
    with harness.sessions() as session:
        assert session.query(RequestLog).order_by(RequestLog.id).all()[-1].status == 503


def test_a_stream_the_caller_closes_is_logged_as_closed_not_as_a_server_error() -> None:
    outcomes: list[tuple[Completion | None, BaseException | None]] = []
    events = iter([Piece(content="b"), Completion("bc", 1, 2, True, 0.1)])
    opened = sse("chatcmpl-1", "m", Piece(content="a"), events, False, lambda *found: outcomes.append(found))
    stream = cast(Generator[str], opened)
    next(stream)
    stream.close()
    assert outcomes == [(None, None)]
    entries: list[LogEntry] = []
    logs = LogBuffer(entries.extend)
    body = ChatCompletionRequest.model_validate({"model": "m", "messages": ASK, "stream": True})
    log_call(logs, CHAT, body, Grant(1, ()), None, "chatcmpl-1", time.monotonic(), Outcome(*outcomes[0]))
    logs.flush()
    assert [entry.status for entry in entries] == [499]


def test_formats_and_contracts_are_checked_before_they_stream(harness: Harness, tmp_path: Path) -> None:
    auth = tool_base(harness, tmp_path, THINKING_TEMPLATE, key="checked")
    harness.backend = Streaming(chunks=['{"a": ', "1}"])
    harness.app.state.backend = harness.backend
    body = {"model": "checked", "messages": ASK, "stream": True, "response_format": {"type": "json_object"}}
    reply = harness.client.post("/v1/chat/completions", headers=auth, json=body)
    first = json.loads(reply.text.split("\n\n")[0].removeprefix("data: "))
    assert first["choices"][0]["delta"]["content"] == '{"a": 1}'
    harness.backend.chunks = ["not json"]
    broken = harness.client.post("/v1/chat/completions", headers=auth, json=body)
    assert broken.status_code == 422


def test_engines_stream_events_over_their_api(harness: Harness, tmp_path: Path) -> None:
    for fake in (Streaming(), FakeBackend(output="whole answer")):
        spec = base_model("qwen3-0.6b")
        app = create_engine_app(
            spec, "http://main", "t", tmp_path / type(fake).__name__, backend=fake, http=harness.client
        )
        with TestClient(app) as engine:
            backend = EngineBackend(
                lambda: {"qwen3-0.6b": [{"url": "http://testserver", "state": "ready"}]}, http=engine
            )
            events = list(backend.stream(CompletionRequest(spec, ASK, None, 8)))
        final = events[-1]
        assert isinstance(final, Completion)
        text = "".join(event.content for event in events if isinstance(event, Piece))
        assert text == final.text and final.text in ("<think>\nPlan it.\n</think>\n\nHello there.", "whole answer")


def test_sglang_streams_content_reasoning_and_calls(tmp_path: Path) -> None:
    log = tmp_path / "requests.jsonl"
    script = Path(__file__).parent / "fake_sglang.py"
    backend = SglangBackend(
        lambda _artifact: tmp_path,
        command=lambda _spec, port: [sys.executable, str(script), "--port", str(port), "--log", str(log)],
        startup_seconds=30,
    )
    try:
        thought = list(backend.stream(CompletionRequest(QWEN3_0_6B, ASK, None, 8, reasoning="high")))
        called = list(
            backend.stream(CompletionRequest(QWEN3_0_6B, ASK, None, 8, tools=ToolUse((WEATHER,), "required")))
        )
    finally:
        backend.close()
    final = drained(iter(thought))
    assert final.text == "base:Weather in Paris?" and final.reasoning == "thought:on" and final.prompt_tokens == 7
    assert len([event for event in thought if isinstance(event, Piece) and event.content]) > 3
    tool = drained(iter(called))
    assert (tool.tool_calls[0].name, json.loads(tool.tool_calls[0].arguments)) == ("get_weather", {"city": "Paris"})
    bodies = [json.loads(line)["body"] for line in log.read_text().splitlines()]
    assert bodies[0]["stream"] is True and bodies[0]["stream_options"] == {"include_usage": True}
