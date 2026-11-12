import json
import os
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

from minibrain.base_models import BaseModelSpec
from minibrain.ml.completion import Completion, Piece, ToolCall
from minibrain.serve.backend import CompletionRequest, EngineUnavailableError, Event, OutputFormatError
from minibrain.serve.dialects import EFFORT, EFFORTS
from minibrain.serve.sampling import UnsupportedParameterError
from minibrain.supervise import Supervisor

STARTUP_SECONDS = 900.0
MAX_LORA_RANK = 64
MAX_LORAS_PER_BATCH = 8

Command = Callable[[BaseModelSpec, int], list[str]]


def error_message(response: httpx.Response) -> str:
    try:
        found = response.json()
    except ValueError:
        return response.text
    if not isinstance(found, dict):
        return str(found)
    nested = found.get("error")
    if isinstance(nested, dict) and nested.get("message"):
        return str(nested["message"])
    return str(found.get("message") or found.get("detail") or found)


def tool_fields(request: CompletionRequest) -> dict[str, Any]:
    use = request.tools
    if not use.tools:
        return {}
    return {"tools": list(use.tools), "tool_choice": use.choice or use.mode, "parallel_tool_calls": use.parallel}


@dataclass
class PartialCalls:
    parts: dict[int, dict[str, str]] = field(default_factory=dict)

    def add(self, deltas: Any) -> None:
        for delta in deltas:
            found = self.parts.setdefault(int(delta.get("index", 0)), {"id": "", "name": "", "arguments": ""})
            function = delta.get("function") or {}
            found["id"] = delta.get("id") or found["id"]
            found["name"] = function.get("name") or found["name"]
            found["arguments"] += function.get("arguments") or ""

    def done(self) -> tuple[ToolCall, ...]:
        return tuple(
            tool_call_of({"id": part["id"], "function": {"name": part["name"], "arguments": part["arguments"]}})
            for _, part in sorted(self.parts.items())
        )


def tool_call_of(call: dict[str, Any]) -> ToolCall:
    function = call.get("function") or {}
    arguments = function.get("arguments")
    text = arguments if isinstance(arguments, str) else json.dumps(arguments or {})
    name = str(function.get("name") or "")
    return ToolCall(name, text, str(call["id"])) if call.get("id") else ToolCall(name, text)


def tool_calls_of(message: dict[str, Any]) -> tuple[ToolCall, ...]:
    return tuple(tool_call_of(call) for call in message.get("tool_calls") or ())


def sampling_fields(request: CompletionRequest) -> dict[str, Any]:
    given = request.sampling.given()
    stops = [*request.base.stop_tokens, *request.sampling.stop]
    return {key: value for key, value in given.items() if key != "stop"} | {"stop": stops}


def endpoint(url: str, request: CompletionRequest) -> str:
    return f"{url}/v1/completions" if request.raw else f"{url}/v1/chat/completions"


class OpenAIServerBackend:
    engine = ""
    device = ""

    def __init__(
        self,
        materialize: Callable[[dict[str, Any]], Path],
        command: Command,
        startup_seconds: float = STARTUP_SECONDS,
    ) -> None:
        self.materialize = materialize
        self.command = command
        self.startup_seconds = startup_seconds
        self.servers: dict[str, tuple[str, Supervisor]] = {}
        self.adapters: dict[str, set[str]] = {}
        self.lock = threading.Lock()
        self.http = httpx.Client(timeout=httpx.Timeout(300.0, connect=5.0))

    def environment(self) -> dict[str, str]:
        return dict(os.environ)

    def wait_healthy(self, url: str) -> None:
        deadline = time.monotonic() + self.startup_seconds
        while time.monotonic() < deadline:
            try:
                if self.http.get(f"{url}/health").status_code == 200:
                    return
            except httpx.TransportError:
                pass
            time.sleep(0.5)
        raise EngineUnavailableError(f"{self.engine} did not become healthy at {url}")

    def load(self, spec: BaseModelSpec) -> str:
        from minibrain.serve.engines import free_port

        with self.lock:
            found = self.servers.get(spec.key)
            if found is not None:
                return found[0]
            port = free_port()
            supervisor = Supervisor(f"{self.device} {spec.key}", self.command(spec, port), self.environment())
            supervisor.start()
            url = f"http://127.0.0.1:{port}"
            self.servers[spec.key] = (url, supervisor)
            self.adapters[spec.key] = set()
        self.wait_healthy(url)
        return url

    def load_path(self) -> str:
        return "/load_lora_adapter"

    def unload_path(self) -> str:
        return "/unload_lora_adapter"

    def ensure_adapter(self, spec: BaseModelSpec, url: str, name: str, artifact: dict[str, Any]) -> None:
        with self.lock:
            if name in self.adapters[spec.key]:
                return
            body = {"lora_name": name, "lora_path": str(self.materialize(artifact))}
            self.http.post(f"{url}{self.load_path()}", json=body).raise_for_status()
            self.adapters[spec.key].add(name)

    def unload_adapter(self, name: str) -> None:
        with self.lock:
            for key, (url, _) in self.servers.items():
                if name in self.adapters.get(key, set()):
                    self.http.post(f"{url}{self.unload_path()}", json={"lora_name": name}).raise_for_status()
                    self.adapters[key].discard(name)

    def constraint_fields(self, request: CompletionRequest) -> dict[str, Any]:
        raise NotImplementedError

    def adapter_fields(self, request: CompletionRequest) -> dict[str, Any]:
        raise NotImplementedError

    def body(self, request: CompletionRequest) -> dict[str, Any]:
        spec = request.base
        found: dict[str, Any] = {"model": spec.key}
        if request.max_tokens is not None:
            found["max_tokens"] = request.max_tokens
        if request.prompt is not None:
            return found | {"prompt": request.prompt} | sampling_fields(request) | self.constraint_fields(request)
        found |= {"messages": request.messages, "chat_template_kwargs": request.template_kwargs()}
        if spec.reasoning == EFFORT and request.reasoning in EFFORTS:
            found["reasoning_effort"] = request.reasoning
        return found | sampling_fields(request) | tool_fields(request) | self.constraint_fields(request)

    def refused(self, request: CompletionRequest, response: httpx.Response) -> None:
        if response.status_code != 400:
            return
        message = error_message(response)
        if request.constraint is not None:
            raise OutputFormatError(f"{self.engine} refused it ({message})")
        for name in request.sampling.names():
            if name in message:
                raise UnsupportedParameterError(name, f"the {self.engine} engine refused {name} ({message})")

    def prepared(self, request: CompletionRequest) -> tuple[str, dict[str, Any]]:
        url = self.load(request.base)
        body = self.body(request)
        if request.adapter is not None:
            self.ensure_adapter(request.base, url, request.adapter.name, request.adapter.artifact)
            body |= self.adapter_fields(request)
        return url, body

    def stream(self, request: CompletionRequest) -> Iterator[Event]:
        url, body = self.prepared(request)
        body |= {"stream": True, "stream_options": {"include_usage": True}}
        started = time.perf_counter()
        with self.http.stream("POST", endpoint(url, request), json=body) as response:
            if response.status_code != 200:
                response.read()
                self.refused(request, response)
                response.raise_for_status()
            yield from self.events(request, response.iter_lines(), started)

    def events(self, request: CompletionRequest, lines: Iterator[str], started: float) -> Iterator[Event]:
        total, calls = Piece(), PartialCalls()
        usage: dict[str, Any] = {}
        finish: str | None = None
        for line in lines:
            data = line.removeprefix("data:").strip()
            if not line.startswith("data:") or not data or data == "[DONE]":
                continue
            chunk = json.loads(data)
            usage = chunk.get("usage") or usage
            for choice in chunk.get("choices") or ():
                finish = choice.get("finish_reason") or finish
                delta = choice.get("delta") or {"content": choice.get("text")}
                calls.add(delta.get("tool_calls") or ())
                thought = delta.get("reasoning_content") or delta.get("reasoning") or ""
                piece = Piece(content=delta.get("content") or "", reasoning=thought)
                total += piece
                if piece:
                    yield piece
        found = calls.done() if request.tools.active else ()
        if found:
            yield Piece(tool_calls=found)
        yield Completion(
            text=total.content,
            prompt_tokens=int(usage.get("prompt_tokens", 0)),
            completion_tokens=int(usage.get("completion_tokens", 0)),
            stopped=finish != "length",
            seconds=time.perf_counter() - started,
            tool_calls=found,
            reasoning=total.reasoning or None,
        )

    def complete(self, request: CompletionRequest) -> Completion:
        url, body = self.prepared(request)
        started = time.perf_counter()
        response = self.http.post(endpoint(url, request), json=body)
        self.refused(request, response)
        response.raise_for_status()
        result = response.json()
        choice = result["choices"][0]
        usage = result.get("usage") or {}
        message = choice.get("message") or {"content": choice.get("text")}
        return Completion(
            text=str(message.get("content") or ""),
            prompt_tokens=int(usage.get("prompt_tokens", 0)),
            completion_tokens=int(usage.get("completion_tokens", 0)),
            stopped=choice.get("finish_reason") != "length",
            seconds=time.perf_counter() - started,
            tool_calls=tool_calls_of(message) if request.tools.active else (),
            reasoning=message.get("reasoning_content") or message.get("reasoning") or None,
        )

    def status(self) -> list[dict[str, Any]]:
        return [
            {"base_model": key, "device": self.device, "adapters": sorted(self.adapters.get(key, set()))}
            for key in self.servers
        ]

    def close(self) -> None:
        for _, supervisor in self.servers.values():
            supervisor.shutdown()
