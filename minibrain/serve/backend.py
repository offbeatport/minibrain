import threading
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol

from minibrain.base_models import BaseModelSpec
from minibrain.ml.completion import Completion

if TYPE_CHECKING:
    from minibrain.ml.runtime import Runtime

Message = dict[str, str]
MAX_ADAPTERS = 32


class EngineUnavailableError(Exception):
    pass


class AdapterNotSupportedError(Exception):
    pass


@dataclass(frozen=True)
class AdapterRef:
    name: str
    artifact: dict[str, Any]


@dataclass(frozen=True)
class CompletionRequest:
    base: BaseModelSpec
    messages: list[Message]
    adapter: AdapterRef | None
    max_tokens: int


class ServingBackend(Protocol):
    def complete(self, request: CompletionRequest) -> Completion: ...

    def status(self) -> list[dict[str, Any]]: ...


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

    def complete(self, request: CompletionRequest) -> Completion:
        with self.lock:
            runtime = self.runtime(request.base)
            if request.adapter is not None:
                self.use_adapter(runtime, request.adapter)
            adapter = request.adapter.name if request.adapter else None
            return runtime.generate([runtime.render(request.messages)], adapter, request.max_tokens)[0]

    def status(self) -> list[dict[str, Any]]:
        return [
            {"base_model": key, "device": runtime.device, "adapters": sorted(runtime.adapters)}
            for key, runtime in self.runtimes.items()
        ]
