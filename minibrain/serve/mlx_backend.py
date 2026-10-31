import json
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from minibrain.base_models import BaseModelSpec
from minibrain.ml.completion import Completion
from minibrain.serve.backend import MAX_ADAPTERS, CompletionRequest
from minibrain.serve.weights import local_dir

PEFT_PREFIX = "base_model.model."
LORA_A = ".lora_A.weight"
LORA_B = ".lora_B.weight"


@dataclass(frozen=True)
class LoraShape:
    rank: int
    scale: float
    keys: tuple[str, ...]


@dataclass(frozen=True)
class MlxAdapter:
    shape: LoraShape
    weights: dict[str, Any]


def layer_key(name: str) -> str:
    _, _, rest = name.partition(".layers.")
    return rest.split(".", 1)[1].rsplit(".", 1)[0]


def convert_peft(path: Path) -> MlxAdapter:
    import mlx.core as mx

    config = json.loads((path / "adapter_config.json").read_text())
    if config.get("peft_type", "LORA") != "LORA" or config.get("use_dora"):
        raise ValueError("only plain LoRA adapters run on MLX")
    tensors = mx.load(str(path / "adapter_model.safetensors"))
    if not isinstance(tensors, dict):
        raise ValueError(f"{path} holds no adapter tensors")
    weights: dict[str, Any] = {}
    for name, tensor in tensors.items():
        key = name.removeprefix(PEFT_PREFIX)
        if key.endswith(LORA_A):
            weights[key.removesuffix(LORA_A) + ".lora_a"] = tensor.T
        elif key.endswith(LORA_B):
            weights[key.removesuffix(LORA_B) + ".lora_b"] = tensor.T
    rank = int(config["r"])
    keys = tuple(sorted({layer_key(name) for name in weights}))
    return MlxAdapter(LoraShape(rank, float(config["lora_alpha"]) / rank, keys), weights)


class MlxRuntime:
    def __init__(self, spec: BaseModelSpec) -> None:
        from mlx_lm import load

        self.spec = spec
        self.source = str(local_dir(spec))
        loaded = load(self.source)
        self.model: Any = loaded[0]
        self.tokenizer: Any = loaded[1]
        for token in spec.stop_tokens:
            if token in self.tokenizer.get_vocab():
                self.tokenizer.add_eos_token(token)
        self.shape: LoraShape | None = None
        self.adapters: OrderedDict[str, MlxAdapter] = OrderedDict()
        self.active: str | None = None
        self.zeros: dict[str, Any] = {}

    def render(self, messages: list[dict[str, str]]) -> list[int]:
        text = self.tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True, **self.spec.template_kwargs
        )
        return list(self.tokenizer.encode(text, add_special_tokens=False))

    def attach(self, shape: LoraShape) -> None:
        import mlx.core as mx
        from mlx_lm import load
        from mlx_lm.tuner.utils import linear_to_lora_layers

        if self.shape is not None:
            loaded = load(self.source)
            self.model = loaded[0]
        config = {"rank": shape.rank, "scale": shape.scale, "dropout": 0.0, "keys": list(shape.keys)}
        linear_to_lora_layers(self.model, len(self.model.layers), config)
        self.model.eval()
        self.shape = shape
        self.active = None
        self.zeros = {
            name: mx.zeros_like(value) for name, value in self.lora_parameters().items() if name.endswith(".lora_b")
        }

    def lora_parameters(self) -> dict[str, Any]:
        from mlx.utils import tree_flatten

        return {name: value for name, value in tree_flatten(self.model.parameters()) if ".lora_" in name}

    def ensure_adapter(self, name: str, path: Path, limit: int = MAX_ADAPTERS) -> None:
        if name not in self.adapters:
            self.adapters[name] = convert_peft(path)
        self.adapters.move_to_end(name)
        while len(self.adapters) > limit:
            dropped, _ = self.adapters.popitem(last=False)
            if dropped == self.active:
                self.active = None

    def activate(self, name: str | None) -> None:
        if name == self.active:
            return
        if name is None:
            if self.shape is not None:
                self.model.load_weights(list(self.zeros.items()), strict=False)
            self.active = None
            return
        adapter = self.adapters[name]
        if adapter.shape != self.shape:
            self.attach(adapter.shape)
        self.model.load_weights(list(adapter.weights.items()), strict=False)
        self.active = name

    def generate(self, messages: list[dict[str, str]], max_tokens: int) -> Completion:
        from mlx_lm import stream_generate
        from mlx_lm.sample_utils import make_sampler

        prompt = self.render(messages)
        started = time.perf_counter()
        parts: list[str] = []
        stopped, generated = False, 0
        for response in stream_generate(
            self.model, self.tokenizer, prompt, max_tokens=max_tokens, sampler=make_sampler(temp=0.0)
        ):
            parts.append(response.text)
            generated = response.generation_tokens
            stopped = response.finish_reason == "stop"
        return Completion(
            text="".join(parts),
            prompt_tokens=len(prompt),
            completion_tokens=generated,
            stopped=stopped,
            seconds=time.perf_counter() - started,
        )


class MlxBackend:
    def __init__(self, materialize: Callable[[dict[str, Any]], Path]) -> None:
        self.materialize = materialize
        self.runtimes: dict[str, MlxRuntime] = {}
        self.lock = threading.Lock()

    def load(self, spec: BaseModelSpec) -> None:
        self.runtime(spec)

    def runtime(self, spec: BaseModelSpec) -> MlxRuntime:
        if spec.key not in self.runtimes:
            self.runtimes[spec.key] = MlxRuntime(spec)
        return self.runtimes[spec.key]

    def complete(self, request: CompletionRequest) -> Completion:
        with self.lock:
            runtime = self.runtime(request.base)
            if request.adapter is not None:
                runtime.ensure_adapter(request.adapter.name, self.materialize(request.adapter.artifact))
            runtime.activate(request.adapter.name if request.adapter else None)
            return runtime.generate(request.messages, request.max_tokens)

    def status(self) -> list[dict[str, Any]]:
        return [
            {"base_model": key, "device": "mlx", "adapters": sorted(runtime.adapters)}
            for key, runtime in self.runtimes.items()
        ]
