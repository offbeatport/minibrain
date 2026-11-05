import json
import os
import shutil
import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, NoReturn, Protocol

import torch
from datasets import Dataset
from peft import LoraConfig
from transformers import TrainerCallback, TrainerControl, TrainerState, TrainingArguments
from trl.trainer.sft_config import SFTConfig
from trl.trainer.sft_trainer import SFTTrainer

from minibrain.data.snapshot import Example, read_split
from minibrain.ml.context import JobSpec, report, run_child, write_result
from minibrain.ml.devices import forced_training_device, half_dtype, kind_of, training_device
from minibrain.ml.examples import encode_all
from minibrain.ml.runtime import load_tokenizer
from minibrain.ml.strategies import (
    fitted_recipe,
    load_training_model,
    lora_settings,
    peak_memory,
    trainer_settings,
)
from minibrain.recipes import DEFAULT_RECIPE
from minibrain.tasks.classify import trained_messages

CHECKPOINT_STEPS = 50
DEVICE_MARK = "training-device"
FIRST_STEP_SECONDS = 900.0
STALL_SECONDS = 180.0
STALL_FACTOR = 10.0
WATCH_SECONDS = 5.0


class Trainer(Protocol):
    def train(self, resume_from_checkpoint: bool) -> Any: ...


class ProgressCallback(TrainerCallback):
    def on_log(self, args: TrainingArguments, state: TrainerState, control: TrainerControl, **kwargs: Any) -> None:
        total = state.max_steps or 1
        report(state.global_step / total, step=state.global_step, steps=total, **(kwargs.get("logs") or {}))


class StallWatch(TrainerCallback):
    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self.clock = clock
        self.since: float | None = None
        self.longest: float | None = None

    def on_train_begin(self, args: TrainingArguments, state: TrainerState, control: TrainerControl, **_: Any) -> None:
        self.since = self.clock()

    def on_step_end(self, args: TrainingArguments, state: TrainerState, control: TrainerControl, **_: Any) -> None:
        moment = self.clock()
        if self.since is not None:
            self.longest = max(self.longest or 0.0, moment - self.since)
        self.since = moment

    def limit(self) -> float:
        return FIRST_STEP_SECONDS if self.longest is None else max(STALL_SECONDS, STALL_FACTOR * self.longest)

    def stalled(self) -> bool:
        return self.since is not None and self.clock() - self.since > self.limit()


def watch(stall: StallWatch, on_stall: Callable[[str], None], stop: threading.Event) -> None:
    while not stop.wait(WATCH_SECONDS):
        if stall.stalled():
            on_stall(f"no training step finished on the Metal GPU in {stall.limit():.0f} s")
            return


def restart_on_cpu(reason: str) -> NoReturn:
    report(device_fallback="cpu", reason=f"{reason}; training again on the CPU")
    sys.stdout.flush()
    os.execv(sys.executable, [sys.executable, "-m", "minibrain.ml.train", *sys.argv[1:]])


def chosen_device(mark: Path, checkpoints: Path) -> str:
    device = training_device()
    if kind_of(device) != "mps" or forced_training_device():
        return device
    tried = mark.read_text().strip() if mark.exists() else None
    if tried is None:
        mark.write_text("mps")
        return device
    if tried == "mps":
        shutil.rmtree(checkpoints, ignore_errors=True)
        mark.write_text("cpu")
    return "cpu"


def training_row(spec: JobSpec, text: str, label: str) -> dict[str, Any]:
    row: dict[str, Any] = {
        "prompt": trained_messages(text),
        "completion": [{"role": "assistant", "content": label}],
    }
    if spec.base.template_kwargs:
        row["chat_template_kwargs"] = dict(spec.base.template_kwargs)
    return row


def training_examples(spec: JobSpec, max_rows: int | None) -> list[Example]:
    return read_split(spec.path("snapshot"), "train")[:max_rows]


def training_rows(spec: JobSpec, examples: list[Example]) -> Dataset:
    return Dataset.from_list([training_row(spec, example.input, example.label) for example in examples])


def micro_batches(recipe: dict[str, Any], device: str) -> tuple[int, int]:
    batch, accumulate = int(recipe["micro_batch"]), int(recipe["grad_accum"])
    return (1, batch * accumulate) if kind_of(device) == "mps" else (batch, accumulate)


def sft_config(checkpoints: Path, recipe: dict[str, Any], device: str) -> SFTConfig:
    batch, accumulate = micro_batches(recipe, device)
    settings = trainer_settings(recipe)
    return SFTConfig(
        output_dir=str(checkpoints),
        num_train_epochs=settings.epochs,
        per_device_train_batch_size=batch,
        gradient_accumulation_steps=accumulate,
        learning_rate=settings.learning_rate,
        max_length=settings.max_length,
        gradient_checkpointing=settings.checkpointing,
        gradient_checkpointing_kwargs={"use_reentrant": False} if settings.checkpointing else None,
        optim=settings.optimizer,
        lr_scheduler_type="cosine",
        warmup_steps=10,
        logging_steps=5,
        save_strategy="steps",
        save_steps=CHECKPOINT_STEPS,
        save_total_limit=1,
        report_to="none",
        disable_tqdm=True,
        completion_only_loss=True,
        dataloader_pin_memory=False,
        use_cpu=device == "cpu",
        bf16=half_dtype(device) == torch.bfloat16,
        fp16=half_dtype(device) == torch.float16,
        seed=7,
    )


def lora_config(recipe: dict[str, Any]) -> LoraConfig:
    settings = lora_settings(recipe)
    return LoraConfig(
        r=settings.rank,
        lora_alpha=settings.alpha,
        lora_dropout=settings.dropout,
        target_modules="all-linear",
        task_type="CAUSAL_LM",
    )


def train(trainer: Trainer, resume: bool, stall: StallWatch | None) -> Any:
    if stall is None:
        return trainer.train(resume_from_checkpoint=resume)
    stop = threading.Event()
    threading.Thread(target=watch, args=(stall, restart_on_cpu, stop), daemon=True).start()
    try:
        return trainer.train(resume_from_checkpoint=resume)
    except Exception as error:
        restart_on_cpu(f"the Metal GPU failed: {type(error).__name__}: {error}")
    finally:
        stop.set()


def main(spec: JobSpec) -> None:
    stored = DEFAULT_RECIPE | spec.raw["recipe"]
    checkpoints = spec.path("checkpoints")
    device = chosen_device(checkpoints.with_name(DEVICE_MARK), checkpoints)
    examples = training_examples(spec, stored["max_rows"])
    tokenizer = load_tokenizer(spec.base, padding_side="right")
    recipe = fitted_recipe(spec, stored, encode_all(tokenizer, examples, spec.base.template_kwargs), device)
    rows = training_rows(spec, examples)
    resume = checkpoints.is_dir() and any(checkpoints.glob("checkpoint-*"))
    print(json.dumps({"device": device, "examples": len(rows), "recipe": recipe, "resume": resume}), flush=True)
    stall = StallWatch() if kind_of(device) == "mps" and not forced_training_device() else None
    trainer = SFTTrainer(
        model=load_training_model(spec.base, device, recipe),
        args=sft_config(checkpoints, recipe, device),
        train_dataset=rows,
        processing_class=tokenizer,
        peft_config=lora_config(recipe),
        callbacks=[ProgressCallback(), *([stall] if stall else [])],
    )
    output = train(trainer, resume, stall)
    trainer.save_model(str(spec.path("adapter_out")))
    summary = recipe | {
        "device": device,
        "examples": len(rows),
        "train_seconds": output.metrics.get("train_runtime"),
        "train_loss": output.metrics.get("train_loss"),
        "peak_bytes": peak_memory(device),
    }
    write_result(spec, {"summary": summary})
    report(1.0, **summary)


if __name__ == "__main__":
    run_child(main)
