import statistics
from collections.abc import Sequence

from minibrain.data.snapshot import Example

Message = dict[str, str]

TRAINED_SYSTEM = "Classify the input. Answer with the label only."


def prompt_only_system(labels: Sequence[str]) -> str:
    listing = "\n".join(labels)
    return f"Classify the input into exactly one label from this list:\n{listing}\n\nAnswer with the label only."


def shot_turns(shots: Sequence[Example]) -> list[Message]:
    turns: list[Message] = []
    for shot in shots:
        turns.append({"role": "user", "content": shot.input})
        turns.append({"role": "assistant", "content": shot.label})
    return turns


def prompt_only_messages(text: str, labels: Sequence[str], shots: Sequence[Example]) -> list[Message]:
    system = {"role": "system", "content": prompt_only_system(labels)}
    return [system, *shot_turns(shots), {"role": "user", "content": text}]


def trained_messages(text: str) -> list[Message]:
    return [{"role": "system", "content": TRAINED_SYSTEM}, {"role": "user", "content": text}]


def build_messages(kind: str, text: str, labels: Sequence[str], shots: Sequence[Example]) -> list[Message]:
    return prompt_only_messages(text, labels, shots) if kind == "prompt" else trained_messages(text)


def parse_label(output: str, labels: Sequence[str]) -> str | None:
    lines = output.strip().splitlines()
    candidate = lines[0].strip().strip("`'\".").lower() if lines else ""
    return {label.lower(): label for label in labels}.get(candidate)


def label_f1(label: str, pairs: list[tuple[str, str | None]]) -> float:
    true_positive = sum(gold == label and predicted == label for gold, predicted in pairs)
    false_positive = sum(gold != label and predicted == label for gold, predicted in pairs)
    false_negative = sum(gold == label and predicted != label for gold, predicted in pairs)
    denominator = 2 * true_positive + false_positive + false_negative
    return 2 * true_positive / denominator if denominator else 0.0


def score(examples: Sequence[Example], outputs: Sequence[str], labels: Sequence[str]) -> dict:
    predicted = [parse_label(output, labels) for output in outputs]
    pairs = [(example.label, label) for example, label in zip(examples, predicted, strict=True)]
    seen = {gold for gold, _ in pairs} | {label for _, label in pairs if label is not None}
    mistakes = [
        {"input": example.input, "gold": example.label, "output": output}
        for example, output, label in zip(examples, outputs, predicted, strict=True)
        if label != example.label
    ]
    return {
        "examples": len(pairs),
        "accuracy": sum(gold == label for gold, label in pairs) / len(pairs) if pairs else 0.0,
        "macro_f1": statistics.mean(label_f1(label, pairs) for label in seen) if seen else 0.0,
        "invalid_rate": sum(label is None for label in predicted) / len(predicted) if predicted else 0.0,
        "mistakes": mistakes[:20],
    }


def latency(seconds: Sequence[float]) -> dict:
    milliseconds = [value * 1000 for value in seconds]
    if len(milliseconds) < 2:
        value = milliseconds[0] if milliseconds else 0.0
        return {"p50_ms": value, "p95_ms": value}
    return {
        "p50_ms": statistics.median(milliseconds),
        "p95_ms": statistics.quantiles(milliseconds, n=20, method="inclusive")[-1],
    }
