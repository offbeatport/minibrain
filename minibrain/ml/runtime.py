import copy
import threading
import time
from collections.abc import Callable, Iterator, Sequence
from contextlib import AbstractContextManager, nullcontext
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

import torch
from peft import PeftModel, PeftModelForCausalLM
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BatchEncoding,
    GenerationConfig,
    GenerationMixin,
    LogitsProcessor,
    LogitsProcessorList,
    PreTrainedModel,
    PreTrainedTokenizerBase,
)

from minibrain.base_models import BaseModelSpec
from minibrain.ml.completion import Completion
from minibrain.ml.devices import pick_device, weights_dtype
from minibrain.serve.sampling import Sampling, StopCutter, stopped_at

if TYPE_CHECKING:
    from minibrain.serve.backend import TemplateTools
from minibrain.serve.structured import TokenTrie

Message = dict[str, Any]
AllowedTokens = Callable[[int, torch.Tensor], list[int]]
CONTEXT_FALLBACK = 4096


def choice_filter(trie: TokenTrie, prompt_length: int, stop: int) -> AllowedTokens:
    def allowed(_row: int, tokens: torch.Tensor) -> list[int]:
        return trie.allowed(tokens[prompt_length:].tolist()) or [stop]

    return allowed


def stop_ids(tokenizer: PreTrainedTokenizerBase, tokens: tuple[str, ...]) -> list[int]:
    vocabulary = tokenizer.get_vocab()
    found = [vocabulary[token] for token in tokens if token in vocabulary]
    eos = tokenizer.eos_token_id
    if isinstance(eos, int) and eos not in found:
        found.append(eos)
    return found


def load_tokenizer(spec: BaseModelSpec, padding_side: str = "left") -> PreTrainedTokenizerBase:
    source, revision = spec.source()
    tokenizer = AutoTokenizer.from_pretrained(source, revision=revision)
    tokenizer.padding_side = padding_side
    return tokenizer


def load_base_model(spec: BaseModelSpec, device: str) -> PreTrainedModel:
    source, revision = spec.source()
    dtype = weights_dtype(device)
    return AutoModelForCausalLM.from_pretrained(source, revision=revision, dtype=dtype, device_map=device)


def as_text(rendered: object) -> str:
    if not isinstance(rendered, str):
        raise TypeError(f"expected text, got {type(rendered).__name__}")
    return rendered


def render_prompt(
    tokenizer: PreTrainedTokenizerBase,
    spec: BaseModelSpec,
    messages: list[Message],
    tools: "TemplateTools" = None,
    kwargs: dict[str, Any] | None = None,
) -> str:
    chosen = spec.template_kwargs if kwargs is None else kwargs
    rendered = tokenizer.apply_chat_template(
        messages, tools=tools, tokenize=False, add_generation_prompt=True, **chosen
    )
    return as_text(rendered)


class CountPenalty(LogitsProcessor):
    def __init__(self, prompt_length: int, presence: float, frequency: float) -> None:
        self.prompt_length = prompt_length
        self.presence = presence
        self.frequency = frequency

    def __call__(self, input_ids: torch.LongTensor, scores: torch.FloatTensor) -> torch.FloatTensor:
        generated = input_ids[:, self.prompt_length :]
        for row in range(generated.shape[0]):
            tokens, counts = torch.unique(generated[row], return_counts=True)
            scores[row, tokens] -= self.presence + self.frequency * counts.to(scores.dtype)
        return scores


def sampled_config(base: GenerationConfig, sampling: Sampling | None) -> GenerationConfig:
    if sampling is None:
        return GenerationConfig(do_sample=False)
    config = copy.deepcopy(base)
    if sampling.temperature is not None:
        config.do_sample = sampling.temperature > 0
        if config.do_sample:
            config.temperature = sampling.temperature
    for name in ("top_p", "top_k", "min_p", "repetition_penalty"):
        value = getattr(sampling, name)
        if value is not None:
            setattr(config, name, value)
    if sampling.stop:
        config.stop_strings = list(sampling.stop)
    return config


def count_penalty(sampling: Sampling | None, prompt_length: int) -> LogitsProcessorList | None:
    if sampling is None or (sampling.presence_penalty is None and sampling.frequency_penalty is None):
        return None
    penalty = CountPenalty(prompt_length, sampling.presence_penalty or 0.0, sampling.frequency_penalty or 0.0)
    return LogitsProcessorList([penalty])


def context_limit(model: PreTrainedModel | PeftModelForCausalLM, tokenizer: PreTrainedTokenizerBase) -> int:
    found = getattr(model.config, "max_position_embeddings", None)
    if isinstance(found, int) and found > 0:
        return found
    length = tokenizer.model_max_length
    return length if isinstance(length, int) and 0 < length < 10**7 else CONTEXT_FALLBACK


def generate_tokens(
    model: PreTrainedModel | PeftModelForCausalLM,
    batch: BatchEncoding,
    config: GenerationConfig,
    allowed: AllowedTokens | None = None,
    **extra: Any,
) -> torch.Tensor:
    if not isinstance(model, PeftModelForCausalLM | GenerationMixin):
        raise TypeError(f"{type(model).__name__} cannot generate")
    output = model.generate(**batch, generation_config=config, prefix_allowed_tokens_fn=allowed, **extra)
    if not isinstance(output, torch.Tensor):
        raise TypeError(f"expected generated token ids, got {type(output).__name__}")
    return output


@dataclass(frozen=True)
class Prepared:
    batch: BatchEncoding
    prompt_length: int
    config: GenerationConfig
    allowed: AllowedTokens | None
    extra: dict[str, Any]


class Runtime:
    def __init__(self, spec: BaseModelSpec, device: str | None = None) -> None:
        self.spec = spec
        self.device = device or pick_device()
        self.tokenizer = load_tokenizer(spec)
        self.model: PreTrainedModel | PeftModelForCausalLM = load_base_model(spec, self.device)
        self.model.eval()
        self.adapters: set[str] = set()
        self.stop_ids = stop_ids(self.tokenizer, spec.stop_tokens)

    def ensure_adapter(self, name: str, path: Path) -> None:
        if name in self.adapters:
            return
        if isinstance(self.model, PeftModelForCausalLM):
            self.model.load_adapter(str(path), adapter_name=name)
        else:
            wrapped = PeftModel.from_pretrained(self.model, str(path), adapter_name=name)
            if not isinstance(wrapped, PeftModelForCausalLM):
                raise TypeError(f"expected a causal LM adapter, got {type(wrapped).__name__}")
            self.model = wrapped
        self.model.eval()
        self.adapters.add(name)

    def drop_adapter(self, name: str) -> None:
        if name not in self.adapters or not isinstance(self.model, PeftModelForCausalLM):
            return
        if len(self.adapters) > 1:
            self.model.delete_adapter(name)
        else:
            self.model = self.model.unload()
            self.model.eval()
        self.adapters.discard(name)

    def render(
        self, messages: list[Message], tools: "TemplateTools" = None, kwargs: dict[str, Any] | None = None
    ) -> str:
        return render_prompt(self.tokenizer, self.spec, messages, tools, kwargs)

    def adapter_scope(self, adapter: str | None) -> AbstractContextManager:
        if not isinstance(self.model, PeftModelForCausalLM):
            if adapter is not None:
                raise ValueError(f"adapter {adapter} is not loaded")
            return nullcontext()
        if adapter is None:
            return self.model.disable_adapter()
        self.model.set_adapter(adapter)
        return nullcontext()

    def completion(
        self, tokens: list[int], prompt_tokens: int, seconds: float, stops: tuple[str, ...] = ()
    ) -> Completion:
        end = next((index for index, token in enumerate(tokens) if token in self.stop_ids), None)
        kept = tokens if end is None else tokens[:end]
        text = as_text(self.tokenizer.decode(kept))
        cut = stopped_at(text, stops)
        return Completion(
            text=text if cut is None else text[:cut],
            prompt_tokens=prompt_tokens,
            completion_tokens=len(kept) + (0 if end is None else 1),
            stopped=end is not None or cut is not None,
            seconds=seconds,
        )

    def choice_trie(self, choices: Sequence[str]) -> TokenTrie:
        stop = self.stop_ids[0]
        return TokenTrie([[*self.tokenizer.encode(choice, add_special_tokens=False), stop] for choice in choices])

    def prepared(
        self, prompts: list[str], max_new_tokens: int | None, choices: Sequence[str], sampling: Sampling | None
    ) -> Prepared:
        batch = self.tokenizer(prompts, return_tensors="pt", padding=True, add_special_tokens=False).to(self.device)
        prompt_length = batch["input_ids"].shape[1]
        allowed = choice_filter(self.choice_trie(choices), prompt_length, self.stop_ids[0]) if choices else None
        room = max(context_limit(self.model, self.tokenizer) - prompt_length, 1)
        config = sampled_config(self.model.generation_config, sampling)
        config.max_new_tokens = min(max_new_tokens or room, room)
        config.eos_token_id = self.stop_ids
        config.pad_token_id = self.tokenizer.pad_token_id
        extra: dict[str, Any] = {"tokenizer": self.tokenizer} if config.stop_strings else {}
        processors = count_penalty(sampling, prompt_length)
        if processors is not None:
            extra["logits_processor"] = processors
        if sampling is not None and sampling.seed is not None:
            torch.manual_seed(sampling.seed)
        return Prepared(batch, prompt_length, config, allowed, extra)

    def stream(
        self,
        prompt: str,
        adapter: str | None,
        max_new_tokens: int | None,
        choices: Sequence[str] = (),
        sampling: Sampling | None = None,
    ) -> Iterator[str | Completion]:
        from transformers import TextIteratorStreamer

        ready = self.prepared([prompt], max_new_tokens, choices, sampling)
        streamer = TextIteratorStreamer(cast(Any, self.tokenizer), skip_prompt=True, skip_special_tokens=False)
        found: dict[str, Any] = {}

        def run() -> None:
            try:
                with self.adapter_scope(adapter), torch.inference_mode():
                    found["output"] = generate_tokens(
                        self.model, ready.batch, ready.config, ready.allowed, streamer=streamer, **ready.extra
                    )
            except Exception as error:
                found["error"] = error
                streamer.end()

        stops = sampling.stop if sampling is not None else ()
        cutter = StopCutter((*self.stop_texts(), *stops))
        started = time.perf_counter()
        worker = threading.Thread(target=run, daemon=True)
        worker.start()
        for text in streamer:
            piece = cutter.feed(text)
            if piece:
                yield piece
        worker.join()
        if "error" in found:
            raise found["error"]
        rest = cutter.finish()
        if rest:
            yield rest
        tokens = found["output"][0][ready.prompt_length :].tolist()
        yield self.completion(tokens, ready.prompt_length, time.perf_counter() - started, stops)

    def stop_texts(self) -> tuple[str, ...]:
        return tuple(text for text in self.tokenizer.convert_ids_to_tokens(self.stop_ids) if isinstance(text, str))

    def generate(
        self,
        prompts: list[str],
        adapter: str | None,
        max_new_tokens: int | None,
        choices: Sequence[str] = (),
        sampling: Sampling | None = None,
    ) -> list[Completion]:
        ready = self.prepared(prompts, max_new_tokens, choices, sampling)
        batch, prompt_length = ready.batch, ready.prompt_length
        started = time.perf_counter()
        with self.adapter_scope(adapter), torch.inference_mode():
            output = generate_tokens(self.model, batch, ready.config, ready.allowed, **ready.extra)
        seconds = time.perf_counter() - started
        counts = batch["attention_mask"].sum(dim=1).tolist()
        stops = sampling.stop if sampling is not None else ()
        return [
            self.completion(row[prompt_length:].tolist(), count, seconds, stops)
            for row, count in zip(output, counts, strict=True)
        ]
