import threading
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Protocol

from minibrain.base_models import BaseModelSpec
from minibrain.ml.completion import Completion

if TYPE_CHECKING:
    from minibrain.ml.runtime import Runtime

Message = dict[str, str]


@dataclass(frozen=True)
class AdapterRef:
    name: str
    path: Path


@dataclass(frozen=True)
class CompletionRequest:
    base: BaseModelSpec
    messages: list[Message]
    adapter: AdapterRef | None
    max_tokens: int


class ServingBackend(Protocol):
    def complete(self, request: CompletionRequest) -> Completion: ...


class TransformersBackend:
    def __init__(self) -> None:
        self.runtimes: dict[str, Runtime] = {}
        self.lock = threading.Lock()

    def runtime(self, spec: BaseModelSpec) -> "Runtime":
        from minibrain.ml.runtime import Runtime

        if spec.key not in self.runtimes:
            self.runtimes[spec.key] = Runtime(spec)
        return self.runtimes[spec.key]

    def complete(self, request: CompletionRequest) -> Completion:
        with self.lock:
            runtime = self.runtime(request.base)
            adapter = None
            if request.adapter is not None:
                runtime.ensure_adapter(request.adapter.name, request.adapter.path)
                adapter = request.adapter.name
            return runtime.generate([runtime.render(request.messages)], adapter, request.max_tokens)[0]
