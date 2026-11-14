import threading
from collections import OrderedDict
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol

from minibrain.base_models import BaseModelSpec
from minibrain.ml.completion import Completion, Piece
from minibrain.serve.dialects import (
    Reader,
    ToolUse,
    prefill,
    read_all,
    reader_for,
    reasoning_kwargs,
    template_messages,
    think_mode,
)
from minibrain.serve.sampling import Sampling
from minibrain.serve.structured import Constraint

if TYPE_CHECKING:
    from minibrain.ml.runtime import Runtime

Message = dict[str, Any]
TemplateTools = list[dict[Any, Any] | Callable[..., Any]] | None
MAX_ADAPTERS = 32


class EngineUnavailableError(Exception):
    pass


class AdapterNotSupportedError(Exception):
    pass


class OutputFormatError(Exception):
    pass


@dataclass(frozen=True)
class AdapterRef:
    name: str
    artifact: dict[str, Any]
    base_hash: str | None = None


@dataclass(frozen=True)
class CompletionRequest:
    base: BaseModelSpec
    messages: list[Message]
    adapter: AdapterRef | None
    max_tokens: int | None
    constraint: Constraint | None = None
    route: str | None = None
    sampling: Sampling = field(default_factory=Sampling)
    tools: ToolUse = field(default_factory=ToolUse)
    reasoning: str | None = None
    template_extra: dict[str, Any] = field(default_factory=dict)
    prompt: str | None = None
    pool: str | None = None

    @property
    def raw(self) -> bool:
        return self.prompt is not None

    def decoding_choices(self) -> tuple[str, ...]:
        return self.constraint.options() if self.constraint else ()

    def template_messages(self) -> list[Message]:
        return template_messages(self.messages)

    def template_tools(self) -> TemplateTools:
        return [*self.tools.tools] if self.tools.active else None

    def prefill(self) -> str:
        return prefill(self.base.tools, self.tools)

    def template_kwargs(self) -> dict[str, Any]:
        found = self.base.template_kwargs | reasoning_kwargs(self.base.reasoning, self.reasoning)
        return found | self.template_extra

    def reader(self) -> Reader:
        if self.raw:
            return reader_for(None, ToolUse())
        return reader_for(self.base.tools, self.tools, think_mode(self.base.reasoning, self.template_kwargs()))


Event = Piece | Completion


def with_bos(bos: object, prompt: str) -> str:
    return bos + prompt if isinstance(bos, str) and bos and not prompt.startswith(bos) else prompt


Raw = Iterator[str | Completion]


def answered(raw: Completion, piece: Piece) -> Completion:
    thought = piece.reasoning.strip() or None
    return replace(raw, text=piece.content, tool_calls=piece.tool_calls, reasoning=thought)


def parsed(request: CompletionRequest, raw: Completion) -> Completion:
    return answered(raw, read_all(request.reader(), request.prefill() + raw.text))


def streamed(request: CompletionRequest, raw: Raw) -> Iterator[Event]:
    reader = request.reader()
    total = reader.feed(request.prefill())
    final: Completion | None = None
    for item in raw:
        if isinstance(item, Completion):
            final = item
            continue
        piece = reader.feed(item)
        total += piece
        if piece:
            yield piece
    rest = reader.finish()
    total += rest
    if rest:
        yield rest
    if final is None:
        raise EngineUnavailableError("the engine stopped before it finished the answer")
    yield answered(final, total)


def drained(events: Iterator[Event]) -> Completion:
    found = [event for event in events if isinstance(event, Completion)]
    return found[-1]


class ServingBackend(Protocol):
    def complete(self, request: CompletionRequest) -> Completion: ...

    def status(self) -> list[dict[str, Any]]: ...


class StreamingBackend(ServingBackend, Protocol):
    def stream(self, request: CompletionRequest) -> Iterator[Event]: ...


class EngineRuntime(ServingBackend, Protocol):
    def load(self, spec: BaseModelSpec) -> Any: ...


class TransformersBackend:
    def __init__(self, materialize: Callable[[dict[str, Any]], Path], max_adapters: int = MAX_ADAPTERS) -> None:
        self.materialize = materialize
        self.max_adapters = max_adapters
        self.runtimes: dict[str, Runtime] = {}
        self.recent: OrderedDict[tuple[str, str], None] = OrderedDict()
        self.lock = threading.Lock()

    def load(self, spec: BaseModelSpec) -> None:
        self.runtime(spec)

    def runtime(self, spec: BaseModelSpec) -> "Runtime":
        from minibrain.ml.runtime import Runtime

        if spec.key not in self.runtimes:
            self.runtimes[spec.key] = Runtime(spec)
        return self.runtimes[spec.key]

    def use_adapter(self, runtime: "Runtime", adapter: AdapterRef) -> None:
        runtime.ensure_adapter(adapter.name, self.materialize(adapter.artifact))
        slot = (runtime.spec.key, adapter.name)
        self.recent[slot] = None
        self.recent.move_to_end(slot)
        while len(self.recent) > self.max_adapters:
            (key, name), _ = self.recent.popitem(last=False)
            self.runtimes[key].drop_adapter(name)

    def unload_adapter(self, name: str) -> None:
        with self.lock:
            for key, runtime in self.runtimes.items():
                runtime.drop_adapter(name)
                self.recent.pop((key, name), None)

    def prompt(self, runtime: "Runtime", request: CompletionRequest) -> str:
        if request.adapter is not None:
            self.use_adapter(runtime, request.adapter)
        if request.prompt is not None:
            return with_bos(runtime.tokenizer.bos_token, request.prompt)
        messages, tools, kwargs = request.template_messages(), request.template_tools(), request.template_kwargs()
        return runtime.render(messages, tools, kwargs) + request.prefill()

    def complete(self, request: CompletionRequest) -> Completion:
        with self.lock:
            runtime = self.runtime(request.base)
            prompt = self.prompt(runtime, request)
            adapter = request.adapter.name if request.adapter else None
            choices = request.decoding_choices()
            raw = runtime.generate([prompt], adapter, request.max_tokens, choices, request.sampling)[0]
            return parsed(request, raw)

    def stream(self, request: CompletionRequest) -> Iterator[Event]:
        with self.lock:
            runtime = self.runtime(request.base)
            prompt = self.prompt(runtime, request)
            adapter = request.adapter.name if request.adapter else None
            choices = request.decoding_choices()
            raw = runtime.stream(prompt, adapter, request.max_tokens, choices, request.sampling)
            yield from streamed(request, raw)

    def status(self) -> list[dict[str, Any]]:
        return [
            {"base_model": key, "device": runtime.device, "adapters": sorted(runtime.adapters)}
            for key, runtime in self.runtimes.items()
        ]
