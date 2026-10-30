import time
from contextlib import AbstractContextManager, nullcontext
from pathlib import Path

import torch
from peft import PeftModel, PeftModelForCausalLM
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BatchEncoding,
    GenerationConfig,
    GenerationMixin,
    PreTrainedModel,
    PreTrainedTokenizerBase,
)

from minibrain.base_models import BaseModelSpec
from minibrain.ml.completion import Completion
from minibrain.ml.devices import pick_device

STOP_TOKENS = ["<|im_end|>", "<|endoftext|>"]
Message = dict[str, str]


def pick_dtype(device: str) -> torch.dtype:
    return torch.bfloat16 if device == "cuda" else torch.float32


def load_tokenizer(spec: BaseModelSpec, padding_side: str = "left") -> PreTrainedTokenizerBase:
    tokenizer = AutoTokenizer.from_pretrained(spec.repo, revision=spec.revision)
    tokenizer.padding_side = padding_side
    return tokenizer


def load_base_model(spec: BaseModelSpec, device: str) -> PreTrainedModel:
    return AutoModelForCausalLM.from_pretrained(
        spec.repo, revision=spec.revision, dtype=pick_dtype(device), device_map=device
    )


def as_text(rendered: object) -> str:
    if not isinstance(rendered, str):
        raise TypeError(f"expected text, got {type(rendered).__name__}")
    return rendered


def render_prompt(tokenizer: PreTrainedTokenizerBase, spec: BaseModelSpec, messages: list[Message]) -> str:
    rendered = tokenizer.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True, **spec.template_kwargs
    )
    return as_text(rendered)


def generate_tokens(
    model: PreTrainedModel | PeftModelForCausalLM, batch: BatchEncoding, config: GenerationConfig
) -> torch.Tensor:
    if not isinstance(model, PeftModelForCausalLM | GenerationMixin):
        raise TypeError(f"{type(model).__name__} cannot generate")
    output = model.generate(**batch, generation_config=config)
    if not isinstance(output, torch.Tensor):
        raise TypeError(f"expected generated token ids, got {type(output).__name__}")
    return output


class Runtime:
    def __init__(self, spec: BaseModelSpec, device: str | None = None) -> None:
        self.spec = spec
        self.device = device or pick_device()
        self.tokenizer = load_tokenizer(spec)
        self.model: PreTrainedModel | PeftModelForCausalLM = load_base_model(spec, self.device)
        self.model.eval()
        self.adapters: set[str] = set()
        converted = self.tokenizer.convert_tokens_to_ids(STOP_TOKENS)
        self.stop_ids = converted if isinstance(converted, list) else [converted]

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

    def render(self, messages: list[Message]) -> str:
        return render_prompt(self.tokenizer, self.spec, messages)

    def adapter_scope(self, adapter: str | None) -> AbstractContextManager:
        if not isinstance(self.model, PeftModelForCausalLM):
            if adapter is not None:
                raise ValueError(f"adapter {adapter} is not loaded")
            return nullcontext()
        if adapter is None:
            return self.model.disable_adapter()
        self.model.set_adapter(adapter)
        return nullcontext()

    def completion(self, tokens: list[int], prompt_tokens: int, seconds: float) -> Completion:
        end = next((index for index, token in enumerate(tokens) if token in self.stop_ids), None)
        kept = tokens if end is None else tokens[:end]
        return Completion(
            text=as_text(self.tokenizer.decode(kept)),
            prompt_tokens=prompt_tokens,
            completion_tokens=len(kept) + (0 if end is None else 1),
            stopped=end is not None,
            seconds=seconds,
        )

    def generate(self, prompts: list[str], adapter: str | None, max_new_tokens: int) -> list[Completion]:
        batch = self.tokenizer(prompts, return_tensors="pt", padding=True, add_special_tokens=False).to(self.device)
        config = GenerationConfig(
            max_new_tokens=max_new_tokens,
            do_sample=False,
            eos_token_id=self.stop_ids,
            pad_token_id=self.tokenizer.pad_token_id,
        )
        started = time.perf_counter()
        with self.adapter_scope(adapter), torch.inference_mode():
            output = generate_tokens(self.model, batch, config)
        seconds = time.perf_counter() - started
        prompt_length = batch["input_ids"].shape[1]
        counts = batch["attention_mask"].sum(dim=1).tolist()
        return [
            self.completion(row[prompt_length:].tolist(), count, seconds)
            for row, count in zip(output, counts, strict=True)
        ]
