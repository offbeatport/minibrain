import inspect
import json
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from minibrain.base_models import BaseModelSpec
from minibrain.ml.completion import Completion
from minibrain.serve.backend import MAX_ADAPTERS, CompletionRequest, Event, parsed, streamed
from minibrain.serve.sampling import GREEDY_SAMPLING, Sampling, StopCutter
from minibrain.serve.structured import TokenTrie
from minibrain.serve.weights import local_dir

CONTEXT_FALLBACK = 4096
SAMPLER_PARAMETERS = {"temperature": "temp", "top_p": "top_p", "min_p": "min_p", "top_k": "top_k"}
DEFAULT_KEYS = ("temperature", "top_p", "top_k", "min_p", "repetition_penalty")

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


def count_processor(prompt_length: int, presence: float, frequency: float) -> Callable[[Any, Any], Any]:
    import mlx.core as mx

    def process(tokens: Any, logits: Any) -> Any:
        generated = tokens[prompt_length:].tolist()
        if not generated:
            return logits
        counts: dict[int, int] = {}
        for token in generated:
            counts[token] = counts.get(token, 0) + 1
        ids = mx.array(list(counts))
        penalty = mx.array([presence + frequency * count for count in counts.values()], dtype=logits.dtype)
        logits[:, ids] = logits[:, ids] - penalty
        return logits

    return process


def model_defaults(folder: Path) -> Sampling:
    try:
        found = json.loads((folder / "generation_config.json").read_text())
    except (OSError, ValueError):
        return GREEDY_SAMPLING
    if not isinstance(found, dict) or not found.get("do_sample"):
        return GREEDY_SAMPLING
    return Sampling(**{key: found[key] for key in DEFAULT_KEYS if isinstance(found.get(key), int | float)})


def sampler_supports() -> set[str]:
    from mlx_lm.sample_utils import make_sampler

    accepted = set(inspect.signature(make_sampler).parameters)
    found = {name for name, argument in SAMPLER_PARAMETERS.items() if argument in accepted}
    return found | {"repetition_penalty", "presence_penalty", "frequency_penalty", "seed", "stop"}


def choice_processor(trie: TokenTrie, prompt_length: int, stop: int) -> Callable[[Any, Any], Any]:
    import mlx.core as mx

    def process(tokens: Any, logits: Any) -> Any:
        allowed = mx.array(trie.allowed(tokens[prompt_length:].tolist()) or [stop])
        mask = mx.full(logits.shape, -mx.inf, dtype=logits.dtype)
        mask[:, allowed] = 0
        return logits + mask

    return process


def context_of(folder: Path) -> int:
    try:
        found = json.loads((folder / "config.json").read_text())
    except (OSError, ValueError):
        return CONTEXT_FALLBACK
    value = found.get("max_position_embeddings") if isinstance(found, dict) else None
    return value if isinstance(value, int) and value > 0 else CONTEXT_FALLBACK


class MlxRuntime:
    def __init__(self, spec: BaseModelSpec) -> None:
        from mlx_lm import load

        self.spec = spec
        self.source = str(local_dir(spec))
        loaded = load(self.source)
        self.model: Any = loaded[0]
        self.tokenizer: Any = loaded[1]
        vocabulary = self.tokenizer.get_vocab()
        stops = [vocabulary[token] for token in spec.stop_tokens if token in vocabulary]
        for token in spec.stop_tokens:
            if token in vocabulary:
                self.tokenizer.add_eos_token(token)
        self.stop: int = stops[0] if stops else self.tokenizer.eos_token_id
        self.defaults = model_defaults(Path(self.source))
        self.supported = sampler_supports()
        self.context = context_of(Path(self.source))
        self.shape: LoraShape | None = None
        self.adapters: OrderedDict[str, MlxAdapter] = OrderedDict()
        self.active: str | None = None
        self.zeros: dict[str, Any] = {}

    def render(self, request: CompletionRequest) -> list[int]:
        text = self.tokenizer.apply_chat_template(
            request.template_messages(),
            tools=request.template_tools(),
            tokenize=False,
            add_generation_prompt=True,
            **request.template_kwargs(),
        )
        return list(self.tokenizer.encode(text + request.prefill(), add_special_tokens=False))

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

    def drop_adapter(self, name: str) -> None:
        if name == self.active:
            self.activate(None)
        self.adapters.pop(name, None)

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

    def processors(
        self, choices: Sequence[str], prompt_length: int, sampling: Sampling
    ) -> list[Callable[[Any, Any], Any]] | None:
        from mlx_lm.sample_utils import make_logits_processors

        found: list[Callable[[Any, Any], Any]] = []
        if choices:
            tokens = [[*self.tokenizer.encode(choice, add_special_tokens=False), self.stop] for choice in choices]
            found.append(choice_processor(TokenTrie(tokens), prompt_length, self.stop))
        if sampling.repetition_penalty is not None:
            found += make_logits_processors(repetition_penalty=sampling.repetition_penalty)
        if sampling.presence_penalty is not None or sampling.frequency_penalty is not None:
            presence, frequency = sampling.presence_penalty or 0.0, sampling.frequency_penalty or 0.0
            found.append(count_processor(prompt_length, presence, frequency))
        return found or None

    def sampler(self, sampling: Sampling) -> Callable[[Any], Any]:
        from mlx_lm.sample_utils import make_sampler

        arguments = {
            SAMPLER_PARAMETERS[name]: value
            for name, value in sampling.given().items()
            if name in SAMPLER_PARAMETERS and name in self.supported
        }
        return make_sampler(**arguments)

    def stream(
        self,
        prompt: list[int],
        max_tokens: int | None,
        choices: Sequence[str] = (),
        sampling: Sampling = GREEDY_SAMPLING,
    ) -> Iterator[str | Completion]:
        import mlx.core as mx
        from mlx_lm import stream_generate

        sampling.refuse_beyond(self.supported, "MLX")
        chosen = sampling.over(self.defaults)
        room = max(self.context - len(prompt), 1)
        if chosen.seed is not None:
            mx.random.seed(chosen.seed)
        started = time.perf_counter()
        cutter = StopCutter(chosen.stop)
        text, stopped, generated = "", False, 0
        for response in stream_generate(
            self.model,
            self.tokenizer,
            prompt,
            max_tokens=min(max_tokens or room, room),
            sampler=self.sampler(chosen),
            logits_processors=self.processors(choices, len(prompt), chosen),
        ):
            piece = cutter.feed(response.text)
            text += piece
            generated = response.generation_tokens
            stopped = response.finish_reason == "stop" or cutter.stopped
            if piece:
                yield piece
            if cutter.stopped:
                break
        rest = cutter.finish()
        if rest:
            text += rest
            yield rest
        yield Completion(
            text=text,
            prompt_tokens=len(prompt),
            completion_tokens=generated,
            stopped=stopped,
            seconds=time.perf_counter() - started,
        )

    def generate(
        self,
        prompt: list[int],
        max_tokens: int | None,
        choices: Sequence[str] = (),
        sampling: Sampling = GREEDY_SAMPLING,
    ) -> Completion:
        found = [item for item in self.stream(prompt, max_tokens, choices, sampling) if isinstance(item, Completion)]
        return found[-1]


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

    def unload_adapter(self, name: str) -> None:
        with self.lock:
            for runtime in self.runtimes.values():
                runtime.drop_adapter(name)

    def complete(self, request: CompletionRequest) -> Completion:
        with self.lock:
            runtime = self.runtime(request.base)
            if request.adapter is not None:
                runtime.ensure_adapter(request.adapter.name, self.materialize(request.adapter.artifact))
            runtime.activate(request.adapter.name if request.adapter else None)
            prompt = runtime.render(request)
            raw = runtime.generate(prompt, request.max_tokens, request.decoding_choices(), request.sampling)
            return parsed(request, raw)

    def stream(self, request: CompletionRequest) -> Iterator[Event]:
        with self.lock:
            runtime = self.runtime(request.base)
            if request.adapter is not None:
                runtime.ensure_adapter(request.adapter.name, self.materialize(request.adapter.artifact))
            runtime.activate(request.adapter.name if request.adapter else None)
            prompt = runtime.render(request)
            raw = runtime.stream(prompt, request.max_tokens, request.decoding_choices(), request.sampling)
            yield from streamed(request, raw)

    def status(self) -> list[dict[str, Any]]:
        return [
            {"base_model": key, "device": "mlx", "adapters": sorted(runtime.adapters)}
            for key, runtime in self.runtimes.items()
        ]
