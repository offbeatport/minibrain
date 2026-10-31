import json
from pathlib import Path
from typing import Any

from datasets import Dataset
from peft import LoraConfig
from transformers import TrainerCallback, TrainerControl, TrainerState, TrainingArguments
from trl.trainer.sft_config import SFTConfig
from trl.trainer.sft_trainer import SFTTrainer

from minibrain.data.snapshot import read_split
from minibrain.ml.context import JobSpec, report, run_child, write_result
from minibrain.ml.devices import training_device
from minibrain.ml.runtime import load_base_model, load_tokenizer
from minibrain.recipes import DEFAULT_RECIPE
from minibrain.tasks.classify import trained_messages

CHECKPOINT_STEPS = 50


class ProgressCallback(TrainerCallback):
    def on_log(self, args: TrainingArguments, state: TrainerState, control: TrainerControl, **kwargs: Any) -> None:
        total = state.max_steps or 1
        report(state.global_step / total, step=state.global_step, steps=total, **(kwargs.get("logs") or {}))


def training_row(spec: JobSpec, text: str, label: str) -> dict[str, Any]:
    row: dict[str, Any] = {
        "prompt": trained_messages(text),
        "completion": [{"role": "assistant", "content": label}],
    }
    if spec.base.template_kwargs:
        row["chat_template_kwargs"] = dict(spec.base.template_kwargs)
    return row


def training_rows(spec: JobSpec, max_rows: int | None) -> Dataset:
    examples = read_split(spec.path("snapshot"), "train")[:max_rows]
    return Dataset.from_list([training_row(spec, example.input, example.label) for example in examples])


def sft_config(checkpoints: Path, recipe: dict[str, Any], device: str) -> SFTConfig:
    return SFTConfig(
        output_dir=str(checkpoints),
        num_train_epochs=float(recipe["epochs"]),
        per_device_train_batch_size=int(recipe["batch_size"]),
        gradient_accumulation_steps=int(recipe["grad_accum"]),
        learning_rate=float(recipe["learning_rate"]),
        lr_scheduler_type="cosine",
        warmup_steps=10,
        logging_steps=5,
        save_strategy="steps",
        save_steps=CHECKPOINT_STEPS,
        save_total_limit=1,
        report_to="none",
        disable_tqdm=True,
        max_length=256,
        completion_only_loss=True,
        dataloader_pin_memory=False,
        use_cpu=device == "cpu",
        bf16=device == "cuda",
        seed=7,
    )


def lora_config(recipe: dict[str, Any]) -> LoraConfig:
    return LoraConfig(
        r=int(recipe["rank"]),
        lora_alpha=int(recipe["alpha"]),
        lora_dropout=0.05,
        target_modules="all-linear",
        task_type="CAUSAL_LM",
    )


def main(spec: JobSpec) -> None:
    recipe = DEFAULT_RECIPE | spec.raw["recipe"]
    device = training_device()
    rows = training_rows(spec, recipe["max_rows"])
    checkpoints = spec.path("checkpoints")
    resume = checkpoints.is_dir() and any(checkpoints.glob("checkpoint-*"))
    print(json.dumps({"device": device, "examples": len(rows), "recipe": recipe, "resume": resume}), flush=True)
    trainer = SFTTrainer(
        model=load_base_model(spec.base, device),
        args=sft_config(checkpoints, recipe, device),
        train_dataset=rows,
        processing_class=load_tokenizer(spec.base, padding_side="right"),
        peft_config=lora_config(recipe),
        callbacks=[ProgressCallback()],
    )
    output = trainer.train(resume_from_checkpoint=resume)
    trainer.save_model(str(spec.path("adapter_out")))
    summary = recipe | {
        "device": device,
        "examples": len(rows),
        "train_seconds": output.metrics.get("train_runtime"),
        "train_loss": output.metrics.get("train_loss"),
    }
    write_result(spec, {"summary": summary})
    report(1.0, **summary)


if __name__ == "__main__":
    run_child(main)
