import time
from contextlib import AbstractContextManager, nullcontext
from dataclasses import dataclass
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

from spikes.banking77.config import MODEL_ID, MODEL_REVISION
from spikes.banking77.prompts import as_text

STOP_TOKENS = ["<|im_end|>", "<|endoftext|>"]


@dataclass(frozen=True)
class Runtime:
    model: PreTrainedModel | PeftModelForCausalLM
    tokenizer: PreTrainedTokenizerBase
    device: str


@dataclass(frozen=True)
class Completion:
    text: str
    prompt_tokens: int
    completion_tokens: int
    stopped: bool
    seconds: float


def pick_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def pick_dtype(device: str) -> torch.dtype:
    return torch.bfloat16 if device == "cuda" else torch.float32


def load_tokenizer(padding_side: str = "left") -> PreTrainedTokenizerBase:
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, revision=MODEL_REVISION)
    tokenizer.padding_side = padding_side
    return tokenizer


def load_base_model(device: str, attention: str = "sdpa") -> PreTrainedModel:
    return AutoModelForCausalLM.from_pretrained(
        MODEL_ID, revision=MODEL_REVISION, dtype=pick_dtype(device), device_map=device, attn_implementation=attention
    )


def attach_adapters(model: PreTrainedModel, adapters: dict[str, Path]) -> PreTrainedModel | PeftModelForCausalLM:
    if not adapters:
        return model
    (first_name, first_path), *rest = adapters.items()
    peft_model = PeftModel.from_pretrained(model, str(first_path), adapter_name=first_name)
    if not isinstance(peft_model, PeftModelForCausalLM):
        raise TypeError(f"expected a causal LM adapter, got {type(peft_model).__name__}")
    for name, path in rest:
        peft_model.load_adapter(str(path), adapter_name=name)
    return peft_model


def load_runtime(adapters: dict[str, Path]) -> Runtime:
    device = pick_device()
    model = attach_adapters(load_base_model(device), adapters)
    model.eval()
    return Runtime(model=model, tokenizer=load_tokenizer(), device=device)


def adapter_scope(model: PreTrainedModel | PeftModelForCausalLM, adapter: str | None) -> AbstractContextManager:
    if not isinstance(model, PeftModel):
        if adapter is not None:
            raise ValueError(f"adapter {adapter} is not loaded")
        return nullcontext()
    if adapter is None:
        return model.disable_adapter()
    model.set_adapter(adapter)
    return nullcontext()


def to_completion(
    runtime: Runtime, tokens: list[int], prompt_tokens: int, stop_ids: list[int], seconds: float
) -> Completion:
    end = next((index for index, token in enumerate(tokens) if token in stop_ids), None)
    kept = tokens if end is None else tokens[:end]
    return Completion(
        text=as_text(runtime.tokenizer.decode(kept)),
        prompt_tokens=prompt_tokens,
        completion_tokens=len(kept) + (0 if end is None else 1),
        stopped=end is not None,
        seconds=seconds,
    )


def generate_tokens(
    model: PreTrainedModel | PeftModelForCausalLM, batch: BatchEncoding, config: GenerationConfig
) -> torch.Tensor:
    if not isinstance(model, PeftModelForCausalLM | GenerationMixin):
        raise TypeError(f"{type(model).__name__} cannot generate")
    output = model.generate(**batch, generation_config=config)
    if not isinstance(output, torch.Tensor):
        raise TypeError(f"expected generated token ids, got {type(output).__name__}")
    return output


def generate(runtime: Runtime, prompts: list[str], adapter: str | None, max_new_tokens: int = 16) -> list[Completion]:
    tokenizer = runtime.tokenizer
    batch = tokenizer(prompts, return_tensors="pt", padding=True, add_special_tokens=False).to(runtime.device)
    converted = tokenizer.convert_tokens_to_ids(STOP_TOKENS)
    stop_ids = converted if isinstance(converted, list) else [converted]
    config = GenerationConfig(
        max_new_tokens=max_new_tokens, do_sample=False, eos_token_id=stop_ids, pad_token_id=tokenizer.pad_token_id
    )
    started = time.perf_counter()
    with adapter_scope(runtime.model, adapter), torch.inference_mode():
        output = generate_tokens(runtime.model, batch, config)
    seconds = time.perf_counter() - started
    prompt_length = batch["input_ids"].shape[1]
    prompt_counts = batch["attention_mask"].sum(dim=1).tolist()
    return [
        to_completion(runtime, row[prompt_length:].tolist(), count, stop_ids, seconds)
        for row, count in zip(output, prompt_counts, strict=True)
    ]
