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
from transformers import PrinterCallback, TrainerCallback, TrainerControl, TrainerState, TrainingArguments
from trl.trainer.sft_config import SFTConfig
from trl.trainer.sft_trainer import SFTTrainer

from minibrain.data.splits import read_split
from minibrain.ml.context import JobSpec, emit, run_child, write_result
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
from minibrain.tasks.examples import Example, assistant_turns
from minibrain.tasks.prompting import Prompting

CHECKPOINT_STEPS = 50
EVAL_ROWS = 64
EVAL_SHARE = 0.1
DEVICE_MARK = "training-device"
FIRST_STEP_SECONDS = 900.0
STALL_SECONDS = 180.0
STALL_FACTOR = 10.0
WATCH_SECONDS = 5.0


class Trainer(Protocol):
    def train(self, resume_from_checkpoint: bool) -> Any: ...


def rounded(value: Any, digits: int = 6) -> float | None:
    return round(float(value), digits) if isinstance(value, int | float) else None


class MetricsCallback(TrainerCallback):
    def __init__(self, memory: Callable[[], int | None], clock: Callable[[], float] = time.monotonic) -> None:
        self.memory = memory
        self.clock = clock
        self.began = 0.0
        self.first_step = 0
        self.last: tuple[float, float] | None = None

    def on_train_begin(self, args: TrainingArguments, state: TrainerState, control: TrainerControl, **_: Any) -> None:
        self.began = self.clock()
        self.first_step = state.global_step
        self.last = None

    def throughput(self, moment: float, tokens: Any) -> float | None:
        if not isinstance(tokens, int | float):
            return None
        last, self.last = self.last, (moment, float(tokens))
        start, seen = last if last is not None else (self.began, 0.0)
        return round((tokens - seen) / (moment - start), 1) if moment > start and tokens >= seen else None

    def eta(self, moment: float, step: int, total: int) -> float | None:
        done = step - self.first_step
        return round((moment - self.began) / done * (total - step), 1) if done > 0 else None

    def on_log(self, args: TrainingArguments, state: TrainerState, control: TrainerControl, **kwargs: Any) -> None:
        logs: dict[str, Any] = kwargs.get("logs") or {}
        step, total = state.global_step, state.max_steps or 1
        if "eval_loss" in logs:
            loss = float(logs["eval_loss"])
            emit("train.eval", f"Held-out loss {loss:.4f} at step {step}", step=step, eval_loss=rounded(loss))
        if "loss" not in logs:
            return
        moment = self.clock()
        loss = float(logs["loss"])
        emit(
            "train.step",
            f"Step {step} of {total}: loss {loss:.4f}",
            progress=step / total,
            step=step,
            steps=total,
            epoch=rounded(state.epoch, 4),
            loss=rounded(loss),
            learning_rate=rounded(logs.get("learning_rate"), 10),
            grad_norm=rounded(logs.get("grad_norm")),
            token_accuracy=rounded(logs.get("mean_token_accuracy")),
            tokens_per_second=self.throughput(moment, logs.get("num_tokens")),
            memory_bytes=self.memory(),
            eta_seconds=self.eta(moment, step, total),
        )


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

    def on_prediction_step(
        self, args: TrainingArguments, state: TrainerState, control: TrainerControl, **_: Any
    ) -> None:
        self.since = self.clock()

    def on_evaluate(self, args: TrainingArguments, state: TrainerState, control: TrainerControl, **_: Any) -> None:
        self.since = self.clock()

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
    emit("train.device_fallback", f"{reason}; training again on the CPU", "warning", device="cpu", reason=reason)
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


def example_rows(spec: JobSpec, prompting: Prompting, example: Example) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for prompt, completion in assistant_turns(example):
        row: dict[str, Any] = {"prompt": prompting.messages(prompt), "completion": [completion]}
        if spec.base.template_kwargs:
            row["chat_template_kwargs"] = dict(spec.base.template_kwargs)
        rows.append(row)
    return rows


def training_examples(spec: JobSpec, max_rows: int | None) -> list[Example]:
    return read_split(spec.path("dataset_version"), "train")[:max_rows]


def training_rows(spec: JobSpec, prompting: Prompting, examples: list[Example]) -> Dataset:
    return Dataset.from_list([row for example in examples for row in example_rows(spec, prompting, example)])


def held_out_rows(spec: JobSpec, prompting: Prompting) -> Dataset | None:
    examples = read_split(spec.path("dataset_version"), "eval")[:EVAL_ROWS]
    return training_rows(spec, prompting, examples) if examples else None


def micro_batches(recipe: dict[str, Any], device: str) -> tuple[int, int]:
    batch, accumulate = int(recipe["micro_batch"]), int(recipe["grad_accum"])
    return (1, batch * accumulate) if kind_of(device) == "mps" else (batch, accumulate)


def sft_config(checkpoints: Path, recipe: dict[str, Any], device: str, evaluate: bool = False) -> SFTConfig:
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
        logging_steps=1,
        eval_strategy="steps" if evaluate else "no",
        eval_steps=EVAL_SHARE if evaluate else None,
        per_device_eval_batch_size=batch,
        prediction_loss_only=True,
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
    prompting = Prompting.from_dict(spec.raw["prompting"])
    tokenizer = load_tokenizer(spec.base, padding_side="right")
    encoded = encode_all(tokenizer, prompting, examples, spec.base.template_kwargs)
    recipe = fitted_recipe(spec, stored, encoded, device)
    rows = training_rows(spec, prompting, examples)
    held_out = held_out_rows(spec, prompting)
    resume = checkpoints.is_dir() and any(checkpoints.glob("checkpoint-*"))
    start = "Resuming training" if resume else "Training"
    emit(
        "train.start",
        f"{start} on {len(rows)} rows on {device}",
        device=device,
        examples=len(rows),
        held_out=len(held_out) if held_out is not None else 0,
        recipe=recipe,
        resume=resume,
    )
    stall = StallWatch() if kind_of(device) == "mps" and not forced_training_device() else None
    trainer = SFTTrainer(
        model=load_training_model(spec.base, device, recipe),
        args=sft_config(checkpoints, recipe, device, evaluate=held_out is not None),
        train_dataset=rows,
        eval_dataset=held_out,
        processing_class=tokenizer,
        peft_config=lora_config(recipe),
        callbacks=[MetricsCallback(lambda: peak_memory(device)), *([stall] if stall else [])],
    )
    trainer.remove_callback(PrinterCallback)
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
    loss = summary["train_loss"]
    took = f" in {summary['train_seconds']:.0f} s" if isinstance(summary["train_seconds"], int | float) else ""
    ended = f"Trained{took}, mean loss {loss:.4f}" if isinstance(loss, int | float) else f"Trained{took}"
    emit("train.done", ended, progress=1.0, **summary)


if __name__ == "__main__":
    run_child(main)
