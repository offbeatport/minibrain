import argparse
import json

from datasets import Dataset
from peft import LoraConfig
from trl.trainer.sft_config import SFTConfig
from trl.trainer.sft_trainer import SFTTrainer

from spikes.banking77.config import ADAPTER_NAME, ADAPTERS_DIR, OUT, SEED
from spikes.banking77.data import read_examples
from spikes.banking77.inference import load_base_model, load_tokenizer, pick_device
from spikes.banking77.prompts import trained_messages


def training_rows(limit: int | None) -> Dataset:
    examples = read_examples("train")[:limit]
    rows = [
        {
            "prompt": trained_messages(example.text),
            "completion": [{"role": "assistant", "content": example.label}],
            "chat_template_kwargs": {"enable_thinking": False},
        }
        for example in examples
    ]
    return Dataset.from_list(rows)


def lora_config() -> LoraConfig:
    return LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, target_modules="all-linear", task_type="CAUSAL_LM")


def sft_config(device: str, epochs: float, max_steps: int, batch_size: int, grad_accum: int) -> SFTConfig:
    return SFTConfig(
        output_dir=str(OUT / "checkpoints"),
        num_train_epochs=epochs,
        max_steps=max_steps,
        per_device_train_batch_size=batch_size,
        gradient_accumulation_steps=grad_accum,
        learning_rate=2e-4,
        lr_scheduler_type="cosine",
        warmup_steps=10,
        logging_steps=10,
        save_strategy="no",
        report_to="none",
        max_length=256,
        completion_only_loss=True,
        dataloader_pin_memory=False,
        use_cpu=device == "cpu",
        bf16=device == "cuda",
        seed=SEED,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--epochs", type=float, default=1.0)
    parser.add_argument("--max-steps", type=int, default=-1)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--grad-accum", type=int, default=1)
    parser.add_argument("--attention", default="sdpa")
    parser.add_argument("--device", default=None)
    args = parser.parse_args()
    device = args.device or pick_device()
    rows = training_rows(args.limit)
    trainer = SFTTrainer(
        model=load_base_model(device, args.attention),
        args=sft_config(device, args.epochs, args.max_steps, args.batch_size, args.grad_accum),
        train_dataset=rows,
        processing_class=load_tokenizer(padding_side="right"),
        peft_config=lora_config(),
    )
    output = trainer.train()
    adapter_dir = ADAPTERS_DIR / ADAPTER_NAME
    trainer.save_model(str(adapter_dir))
    summary = {"device": device, "examples": len(rows), **output.metrics}
    (adapter_dir / "training.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
