import json
import sys
from typing import Any

from datasets import Dataset
from peft import LoraConfig
from sqlalchemy.orm import Session, sessionmaker
from transformers import TrainerCallback, TrainerControl, TrainerState, TrainingArguments
from trl.trainer.sft_config import SFTConfig
from trl.trainer.sft_trainer import SFTTrainer

from minibrain.data.snapshot import read_split
from minibrain.ml.context import JobContext, load_context, set_progress, update_version
from minibrain.ml.devices import training_device
from minibrain.ml.runtime import load_base_model, load_tokenizer
from minibrain.recipes import DEFAULT_RECIPE
from minibrain.registry.db import make_sessions
from minibrain.settings import load_settings
from minibrain.tasks.classify import trained_messages


class ProgressCallback(TrainerCallback):
    def __init__(self, sessions: sessionmaker[Session], job_id: int) -> None:
        self.sessions = sessions
        self.job_id = job_id

    def on_log(self, args: TrainingArguments, state: TrainerState, control: TrainerControl, **kwargs: Any) -> None:
        total = state.max_steps or 1
        set_progress(self.sessions, self.job_id, state.global_step / total)
        entry = {"step": state.global_step, "steps": total} | (kwargs.get("logs") or {})
        print(json.dumps(entry), flush=True)


def training_row(context: JobContext, text: str, label: str) -> dict[str, Any]:
    row: dict[str, Any] = {
        "prompt": trained_messages(text),
        "completion": [{"role": "assistant", "content": label}],
    }
    if context.spec.template_kwargs:
        row["chat_template_kwargs"] = dict(context.spec.template_kwargs)
    return row


def training_rows(context: JobContext, max_rows: int | None) -> Dataset:
    examples = read_split(context.snapshot_dir, "train")[:max_rows]
    return Dataset.from_list([training_row(context, example.input, example.label) for example in examples])


def sft_config(context: JobContext, recipe: dict[str, Any], device: str) -> SFTConfig:
    return SFTConfig(
        output_dir=str(context.snapshot_dir.parent.parent / "checkpoints" / f"v{context.number}"),
        num_train_epochs=float(recipe["epochs"]),
        per_device_train_batch_size=int(recipe["batch_size"]),
        gradient_accumulation_steps=int(recipe["grad_accum"]),
        learning_rate=float(recipe["learning_rate"]),
        lr_scheduler_type="cosine",
        warmup_steps=10,
        logging_steps=5,
        save_strategy="no",
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


def main(job_id: int) -> None:
    sessions = make_sessions(load_settings().database_url)
    context = load_context(sessions, job_id)
    if context.adapter_dir is None:
        raise ValueError(f"{context.slug}@{context.number} has no adapter directory")
    recipe = DEFAULT_RECIPE | context.recipe
    device = training_device()
    rows = training_rows(context, recipe["max_rows"])
    print(json.dumps({"device": device, "examples": len(rows), "recipe": recipe}), flush=True)
    trainer = SFTTrainer(
        model=load_base_model(context.spec, device),
        args=sft_config(context, recipe, device),
        train_dataset=rows,
        processing_class=load_tokenizer(context.spec, padding_side="right"),
        peft_config=lora_config(recipe),
        callbacks=[ProgressCallback(sessions, job_id)],
    )
    output = trainer.train()
    trainer.save_model(str(context.adapter_dir))
    summary = recipe | {
        "device": device,
        "examples": len(rows),
        "train_seconds": output.metrics.get("train_runtime"),
        "train_loss": output.metrics.get("train_loss"),
    }
    update_version(sessions, context.version_id, recipe=summary)
    print(json.dumps(summary), flush=True)


if __name__ == "__main__":
    main(int(sys.argv[1]))
