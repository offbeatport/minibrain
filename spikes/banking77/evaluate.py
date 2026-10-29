import argparse
import json
import statistics

from spikes.banking77.config import MODEL_ID, RESULTS_DIR
from spikes.banking77.data import Example, read_examples, read_labels
from spikes.banking77.inference import Completion, Runtime, generate, load_runtime
from spikes.banking77.prompts import parse_label, render_prompt
from spikes.banking77.versions import Version, adapter_paths, load_versions


def predict(runtime: Runtime, version: Version, examples: list[Example], batch_size: int) -> list[Completion]:
    prompts = [render_prompt(runtime.tokenizer, version.build_messages(example.text)) for example in examples]
    completions: list[Completion] = []
    for start in range(0, len(prompts), batch_size):
        completions += generate(runtime, prompts[start : start + batch_size], version.adapter)
    return completions


def label_f1(label: str, gold: list[str], predicted: list[str | None]) -> float:
    pairs = list(zip(gold, predicted, strict=True))
    true_positive = sum(g == label and p == label for g, p in pairs)
    false_positive = sum(g != label and p == label for g, p in pairs)
    false_negative = sum(g == label and p != label for g, p in pairs)
    denominator = 2 * true_positive + false_positive + false_negative
    return 2 * true_positive / denominator if denominator else 0.0


def macro_f1(gold: list[str], predicted: list[str | None]) -> float:
    labels = set(gold) | {label for label in predicted if label is not None}
    return statistics.mean(label_f1(label, gold, predicted) for label in labels)


def score(examples: list[Example], completions: list[Completion], labels: set[str]) -> dict:
    gold = [example.label for example in examples]
    predicted = [parse_label(completion.text, labels) for completion in completions]
    mistakes = [
        {"text": example.text, "gold": example.label, "output": completion.text}
        for example, completion, label in zip(examples, completions, predicted, strict=True)
        if label != example.label
    ]
    return {
        "examples": len(examples),
        "accuracy": sum(g == p for g, p in zip(gold, predicted, strict=True)) / len(gold),
        "macro_f1": macro_f1(gold, predicted),
        "invalid_rate": sum(label is None for label in predicted) / len(predicted),
        "mistakes": mistakes[:10],
    }


def latency(completions: list[Completion]) -> dict:
    milliseconds = [completion.seconds * 1000 for completion in completions]
    return {
        "p50_ms": statistics.median(milliseconds),
        "p95_ms": statistics.quantiles(milliseconds, n=20, method="inclusive")[-1],
    }


def evaluate(version_name: str, batch_size: int) -> dict:
    version = load_versions()[version_name]
    runtime = load_runtime(adapter_paths([version]))
    labels = set(read_labels())
    golden = read_examples("golden")
    held_out = read_examples("eval")
    predict(runtime, version, golden[:2], batch_size=1)
    golden_completions = predict(runtime, version, golden, batch_size=1)
    eval_completions = predict(runtime, version, held_out, batch_size=batch_size)
    return {
        "version": version_name,
        "model": MODEL_ID,
        "adapter": version.adapter,
        "device": runtime.device,
        "golden": score(golden, golden_completions, labels),
        "eval": score(held_out, eval_completions, labels),
        "latency": latency(golden_completions),
        "prompt_tokens": statistics.mean(completion.prompt_tokens for completion in golden_completions),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("version")
    parser.add_argument("--batch-size", type=int, default=8)
    args = parser.parse_args()
    result = evaluate(args.version, args.batch_size)
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    (RESULTS_DIR / f"{args.version}.json").write_text(json.dumps(result, indent=2))
    summary = {key: result[key] for key in ("version", "latency", "prompt_tokens")}
    for split in ("golden", "eval"):
        summary[split] = {key: result[split][key] for key in ("accuracy", "macro_f1", "invalid_rate")}
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
