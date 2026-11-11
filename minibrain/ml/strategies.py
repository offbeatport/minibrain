import resource
import sys
from dataclasses import dataclass
from typing import Any

import torch
from transformers import AutoModelForCausalLM, BitsAndBytesConfig, PreTrainedModel

from minibrain.base_models import BaseModelSpec
from minibrain.ml.context import FinalError, JobSpec
from minibrain.ml.devices import device_name, half_dtype, kind_of
from minibrain.ml.examples import Encoded, longest, truncated
from minibrain.ml.planner import (
    DEFAULT_SEED,
    QLORA,
    Base,
    Machine,
    Plan,
    Settings,
    plan_machine,
    seq_len_for,
)
from minibrain.ml.runtime import load_base_model
from minibrain.models.hardware import ram_bytes
from minibrain.versions import installed_versions

PLAN_BASE = "plan_base"
PINNED = ("strategy", "checkpointing", "micro_batch")


def device_memory(device: str) -> int | None:
    kind = kind_of(device)
    if kind == "cuda" and torch.cuda.is_available():
        return int(torch.cuda.get_device_properties(torch.device(device)).total_memory)
    if kind == "xpu" and hasattr(torch, "xpu") and torch.xpu.is_available():
        return int(torch.xpu.get_device_properties(torch.device(device)).total_memory)
    if kind == "mps" and hasattr(torch.mps, "recommended_max_memory"):
        return int(torch.mps.recommended_max_memory())
    return None


def machine_kind(device: str) -> str:
    kind = kind_of(device)
    if kind == "cuda" and getattr(torch.version, "hip", None):
        return "rocm"
    return kind


def machine_here(device: str) -> Machine:
    return Machine(
        device_name(device), machine_kind(device), device_memory(device), ram_bytes(), frozenset(installed_versions())
    )


def base_of(spec: JobSpec) -> Base:
    found = spec.raw.get(PLAN_BASE)
    if found:
        return Base.from_dict(found)
    return Base.of(spec.base.key, None, None, None, None)


def settings_of(recipe: dict[str, Any], keep: tuple[str, ...]) -> Settings:
    overrides = set(recipe.get("overrides") or [])
    pinned = {name: recipe.get(name) for name in PINNED if name in keep or name in overrides}
    return Settings(
        strategy=pinned.get("strategy"),
        checkpointing=pinned.get("checkpointing"),
        micro_batch=pinned.get("micro_batch"),
        seq_len=int(recipe["seq_len"]) if "seq_len" in overrides else None,
        rank=int(recipe["rank"]),
        learning_rate=float(recipe["learning_rate"]),
        epochs=float(recipe["epochs"]),
        max_rows=int(recipe["max_rows"]),
        alpha=int(recipe["alpha"]) if "alpha" in overrides else None,
        grad_accum=int(recipe["grad_accum"]) if "grad_accum" in overrides else None,
        eval_every=int(recipe["eval_every"]) if recipe.get("eval_every") else None,
        seed=int(recipe.get("seed", DEFAULT_SEED)),
    )


def fit_here(base: Base, machine: Machine, recipe: dict[str, Any], encoded: list[Encoded]) -> tuple[Plan, bool]:
    tokens = longest(encoded)
    rows = len(encoded)
    stored = settings_of(recipe, PINNED if recipe.get("strategy") else ())
    first = plan_machine(base, machine, stored, seq_len_for(base, stored, tokens), rows)
    if first.chosen is not None:
        return first, False
    loose = settings_of(recipe, ())
    return plan_machine(base, machine, loose, seq_len_for(base, loose, tokens), rows), True


def fitted_recipe(spec: JobSpec, recipe: dict[str, Any], encoded: list[Encoded], device: str) -> dict[str, Any]:
    machine = machine_here(device)
    found, replanned = fit_here(base_of(spec), machine, recipe, encoded)
    if found.chosen is None:
        raise FinalError(found.refusal or f"{spec.base.key} does not fit for training on {machine.name}")
    planned = found.recipe()
    planned["overrides"] = list(recipe.get("overrides") or [])
    return (
        recipe
        | planned
        | {
            "longest_tokens": longest(encoded),
            "truncated": truncated(encoded, found.seq_len),
            "replanned": replanned,
        }
    )


def compute_dtype(device: str) -> torch.dtype:
    return half_dtype(device) or torch.bfloat16


def quantization_config(recipe: dict[str, Any], device: str) -> BitsAndBytesConfig | None:
    if recipe.get("strategy") != QLORA:
        return None
    return BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
        bnb_4bit_compute_dtype=compute_dtype(device),
    )


def load_training_model(spec: BaseModelSpec, device: str, recipe: dict[str, Any]) -> PreTrainedModel:
    quantized = quantization_config(recipe, device)
    if quantized is None:
        return load_base_model(spec, device)
    source, revision = spec.source()
    return AutoModelForCausalLM.from_pretrained(
        source, revision=revision, quantization_config=quantized, dtype=compute_dtype(device), device_map=device
    )


@dataclass(frozen=True)
class TrainerSettings:
    epochs: float
    micro_batch: int
    grad_accum: int
    learning_rate: float
    max_length: int
    checkpointing: bool
    optimizer: str


@dataclass(frozen=True)
class LoraSettings:
    rank: int
    alpha: int
    dropout: float


def trainer_settings(recipe: dict[str, Any]) -> TrainerSettings:
    return TrainerSettings(
        epochs=float(recipe["epochs"]),
        micro_batch=int(recipe["micro_batch"]),
        grad_accum=int(recipe["grad_accum"]),
        learning_rate=float(recipe["learning_rate"]),
        max_length=int(recipe["seq_len"]),
        checkpointing=bool(recipe.get("checkpointing")),
        optimizer=str(recipe.get("optimizer") or "adamw_torch"),
    )


def lora_settings(recipe: dict[str, Any]) -> LoraSettings:
    return LoraSettings(rank=int(recipe["rank"]), alpha=int(recipe["alpha"]), dropout=float(recipe["dropout"]))


def peak_memory(device: str) -> int | None:
    kind = kind_of(device)
    if kind == "cuda" and torch.cuda.is_available():
        return int(torch.cuda.max_memory_reserved(torch.device(device)))
    if kind == "xpu" and hasattr(torch, "xpu") and torch.xpu.is_available():
        return int(torch.xpu.max_memory_reserved(torch.device(device)))
    if kind == "mps":
        return int(torch.mps.driver_allocated_memory())
    usage = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(usage if sys.platform == "darwin" else usage * 1024)
