import hashlib
import json
import re
import statistics
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

from minibrain.serve.structured import violation
from minibrain.tasks.contracts import Contract, answer_of, parse_json, parse_label
from minibrain.tasks.examples import Example

MISTAKES = 20
WORD = re.compile(r"\w+")


class GraderError(ValueError):
    pass


@dataclass(frozen=True)
class Scored:
    example: Example
    answer: str
    scores: dict[str, float]


@dataclass(frozen=True)
class Summary:
    metrics: dict[str, float]
    report: dict[str, Any] = field(default_factory=dict)


class Grader(Protocol):
    @property
    def name(self) -> str: ...

    @property
    def version(self) -> int: ...

    @property
    def metrics(self) -> tuple[str, ...]: ...

    def score(self, answer: str, example: Example) -> dict[str, float]: ...

    def summarize(self, scored: Sequence[Scored]) -> Summary: ...


def mean_of(values: Sequence[float]) -> float:
    return statistics.mean(values) if values else 0.0


def mean_summary(metrics: Sequence[str], scored: Sequence[Scored]) -> Summary:
    found = {name: [row.scores[name] for row in scored if name in row.scores] for name in metrics}
    return Summary({name: statistics.mean(values) for name, values in found.items() if values})


@dataclass(frozen=True)
class ExactMatch:
    name: str = "exact_match"
    version: int = 1
    metrics: tuple[str, ...] = ("exact_match",)

    def score(self, answer: str, example: Example) -> dict[str, float]:
        return {"exact_match": float(answer.strip() == example.expected.strip())}

    def summarize(self, scored: Sequence[Scored]) -> Summary:
        return mean_summary(self.metrics, scored)


def label_f1(label: str, pairs: Sequence[tuple[str, str | None]]) -> float:
    true_positive = sum(gold == label and predicted == label for gold, predicted in pairs)
    false_positive = sum(gold != label and predicted == label for gold, predicted in pairs)
    false_negative = sum(gold == label and predicted != label for gold, predicted in pairs)
    denominator = 2 * true_positive + false_positive + false_negative
    return 2 * true_positive / denominator if denominator else 0.0


def ratio(part: int, whole: int) -> float | None:
    return part / whole if whole else None


def label_scores(labels: Sequence[str], pairs: Sequence[tuple[str, str | None]]) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    for label in sorted(set(labels) | {gold for gold, _ in pairs}):
        support = sum(gold == label for gold, _ in pairs)
        predicted = sum(guess == label for _, guess in pairs)
        correct = sum(gold == label and guess == label for gold, guess in pairs)
        found.append(
            {
                "label": label,
                "support": support,
                "predicted": predicted,
                "correct": correct,
                "precision": ratio(correct, predicted),
                "recall": ratio(correct, support),
                "f1": ratio(2 * correct, support + predicted),
            }
        )
    return found


def confusion(pairs: Sequence[tuple[str, str | None]]) -> list[dict[str, Any]]:
    counts = Counter((gold, guess) for gold, guess in pairs if gold != guess)
    ordered = sorted(counts.items(), key=lambda item: (-item[1], item[0][0], item[0][1] or ""))
    return [{"gold": gold, "predicted": guess, "count": count} for (gold, guess), count in ordered]


@dataclass(frozen=True)
class LabelAccuracy:
    labels: tuple[str, ...]
    name: str = "label_accuracy"
    version: int = 1
    metrics: tuple[str, ...] = ("label_accuracy", "macro_f1")

    def score(self, answer: str, example: Example) -> dict[str, float]:
        return {"label_accuracy": float(parse_label(answer, self.labels) == example.expected)}

    def summarize(self, scored: Sequence[Scored]) -> Summary:
        pairs = [(row.example.expected, parse_label(row.answer, self.labels)) for row in scored]
        seen = {gold for gold, _ in pairs} | {label for _, label in pairs if label is not None}
        accuracy = sum(gold == label for gold, label in pairs) / len(pairs) if pairs else 0.0
        macro = statistics.mean(label_f1(label, pairs) for label in seen) if seen else 0.0
        report = {"labels": label_scores(self.labels, pairs), "confusion": confusion(pairs)}
        return Summary({"label_accuracy": accuracy, "macro_f1": macro}, report)


@dataclass(frozen=True)
class JsonValid:
    schema: dict[str, Any] | None = None
    name: str = "json_valid"
    version: int = 1
    metrics: tuple[str, ...] = ("json_valid",)

    def score(self, answer: str, example: Example) -> dict[str, float]:
        parsed, value = parse_json(answer)
        matches = parsed and (self.schema is None or violation(self.schema, value) is None)
        return {"json_valid": float(matches)}

    def summarize(self, scored: Sequence[Scored]) -> Summary:
        return mean_summary(self.metrics, scored)


def json_object(text: str) -> dict[str, Any] | None:
    parsed, value = parse_json(text)
    return value if parsed and isinstance(value, dict) else None


@dataclass(frozen=True)
class JsonFieldMatch:
    fields: tuple[str, ...] = ()
    name: str = "json_field_match"
    version: int = 1
    metrics: tuple[str, ...] = ("json_field_match",)

    def compared(self, expected: dict[str, Any]) -> tuple[str, ...]:
        return self.fields or tuple(sorted(expected))

    def matches(self, answer: str, example: Example) -> dict[str, bool]:
        expected = json_object(example.expected) or {}
        found = json_object(answer) or {}
        return {name: name in found and found[name] == expected.get(name) for name in self.compared(expected)}

    def score(self, answer: str, example: Example) -> dict[str, float]:
        matched = self.matches(answer, example)
        return {"json_field_match": mean_of([float(value) for value in matched.values()]) if matched else 0.0}

    def summarize(self, scored: Sequence[Scored]) -> Summary:
        per_field: dict[str, list[float]] = {}
        for row in scored:
            for name, matched in self.matches(row.answer, row.example).items():
                per_field.setdefault(name, []).append(float(matched))
        report = {
            "fields": [{"field": name, "accuracy": mean_of(values)} for name, values in sorted(per_field.items())]
        }
        return Summary(mean_summary(self.metrics, scored).metrics, report)


def words(text: str) -> list[str]:
    return WORD.findall(text.lower())


def token_f1(answer: str, expected: str) -> float:
    found, wanted = Counter(words(answer)), Counter(words(expected))
    if not found and not wanted:
        return 1.0
    common = sum((found & wanted).values())
    if not common:
        return 0.0
    precision, recall = common / sum(found.values()), common / sum(wanted.values())
    return 2 * precision * recall / (precision + recall)


@dataclass(frozen=True)
class TextSimilarity:
    name: str = "text_similarity"
    version: int = 1
    metrics: tuple[str, ...] = ("text_similarity",)

    def score(self, answer: str, example: Example) -> dict[str, float]:
        return {"text_similarity": token_f1(answer, example.expected)}

    def summarize(self, scored: Sequence[Scored]) -> Summary:
        return mean_summary(self.metrics, scored)


def digest(payload: Any) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def answer_hash(example: Example, answer: str) -> str:
    return digest({"messages": example.messages(), "expected": example.expected, "answer": answer})


def judge_key(answer_digest: str, rubric: str, model: str, model_version: str) -> str:
    return digest([answer_digest, rubric, model, model_version])


@dataclass(frozen=True)
class Judge:
    rubric: str
    model: str
    model_version: str = ""
    found: Mapping[str, float] = field(default_factory=dict)
    name: str = "judge"
    version: int = 1
    metrics: tuple[str, ...] = ("judge",)

    def key(self, answer: str, example: Example) -> str:
        return judge_key(answer_hash(example, answer), self.rubric, self.model, self.model_version)

    def score(self, answer: str, example: Example) -> dict[str, float]:
        value = self.found.get(self.key(answer, example))
        return {} if value is None else {"judge": value}

    def summarize(self, scored: Sequence[Scored]) -> Summary:
        judged = [row for row in scored if "judge" in row.scores]
        summary = mean_summary(self.metrics, judged)
        return Summary(summary.metrics, {"judged": len(judged), "pending": len(scored) - len(judged)})


@dataclass(frozen=True)
class GraderInfo:
    name: str
    label: str
    description: str
    contracts: tuple[str, ...]
    metrics: tuple[str, ...]


CATALOGUE: tuple[GraderInfo, ...] = (
    GraderInfo(
        "label_accuracy",
        "Label accuracy",
        "Share of answers that are the expected label, with macro F1 and a confusion matrix.",
        ("labels",),
        ("label_accuracy", "macro_f1"),
    ),
    GraderInfo(
        "exact_match",
        "Exact match",
        "Share of answers identical to the expected one.",
        ("text", "json", "labels"),
        ("exact_match",),
    ),
    GraderInfo(
        "json_valid", "JSON valid", "Share of answers that parse and match the schema.", ("json",), ("json_valid",)
    ),
    GraderInfo(
        "json_field_match",
        "JSON field match",
        "Share of expected fields the answer gets right, per field.",
        ("json",),
        ("json_field_match",),
    ),
    GraderInfo(
        "text_similarity",
        "Text similarity",
        "Word overlap with the expected answer (token F1).",
        ("text", "json"),
        ("text_similarity",),
    ),
    GraderInfo(
        "judge",
        "Judge model",
        "A model on this install scores each answer against your rubric, as its own job.",
        ("text", "json"),
        ("judge",),
    ),
)
BY_NAME = {info.name: info for info in CATALOGUE}

Builder = Callable[[dict[str, Any], Contract, Mapping[str, float]], Grader]


def option(config: dict[str, Any], key: str) -> str:
    value = config.get(key)
    if not isinstance(value, str) or not value.strip():
        raise GraderError(f"the {config.get('name')} grader needs {key}")
    return value.strip()


def labelled(config: dict[str, Any], contract: Contract, _found: Mapping[str, float]) -> Grader:
    if contract.labels is None:
        raise GraderError("label accuracy needs a label set contract")
    return LabelAccuracy(labels=contract.labels)


def judged(config: dict[str, Any], _contract: Contract, found: Mapping[str, float]) -> Grader:
    version = config.get("model_version")
    return Judge(option(config, "rubric"), option(config, "model"), str(version or ""), found)


BUILDERS: dict[str, Builder] = {
    "label_accuracy": labelled,
    "exact_match": lambda _config, _contract, _found: ExactMatch(),
    "json_valid": lambda _config, contract, _found: JsonValid(contract.schema),
    "json_field_match": lambda config, _contract, _found: JsonFieldMatch(tuple(config.get("fields") or ())),
    "text_similarity": lambda _config, _contract, _found: TextSimilarity(),
    "judge": judged,
}


def build(config: dict[str, Any], contract: Contract, found: Mapping[str, float] | None = None) -> Grader:
    builder = BUILDERS.get(str(config.get("name")))
    if builder is None:
        raise GraderError(f"no grader called {config.get('name')}")
    return builder(config, contract, found or {})


def check_configs(configs: Sequence[dict[str, Any]], contract: Contract) -> None:
    if not configs:
        raise GraderError("pick at least one grader")
    names = [str(config.get("name")) for config in configs]
    if len(set(names)) != len(names):
        raise GraderError("each grader can be picked once")
    for config in configs:
        build(config, contract)


def main_metric(configs: Sequence[dict[str, Any]]) -> str | None:
    if not configs:
        return None
    info = BY_NAME.get(str(configs[0].get("name")))
    return info.metrics[0] if info else None


def mistakes(graders: Sequence[Grader], examples: Sequence[Example], answers: Sequence[str]) -> list[dict[str, str]]:
    if not graders:
        return []
    main, metric = graders[0], graders[0].metrics[0]
    wrong: list[dict[str, str]] = []
    for example, answer in zip(examples, answers, strict=True):
        scores = main.score(answer, example)
        if metric in scores and scores[metric] < 1:
            wrong.append({"input": example.input, "gold": example.expected, "output": answer})
        if len(wrong) == MISTAKES:
            break
    return wrong


def grade(
    graders: Sequence[Grader], contract: Contract, examples: Sequence[Example], answers: Sequence[str]
) -> dict[str, Any]:
    scores: list[dict[str, Any]] = []
    reports: dict[str, Any] = {}
    for grader in graders:
        scored = [
            Scored(example, answer, grader.score(answer, example))
            for example, answer in zip(examples, answers, strict=True)
        ]
        summary = grader.summarize(scored)
        scores += [
            {"grader": grader.name, "version": grader.version, "metric": name, "value": value}
            for name, value in summary.metrics.items()
        ]
        if summary.report:
            reports[grader.name] = summary.report
    invalid = [not answer_of(contract, answer).valid for answer in answers]
    return {
        "examples": len(examples),
        "invalid_rate": sum(invalid) / len(invalid) if invalid else 0.0,
        "scores": scores,
        "reports": reports,
        "mistakes": mistakes(graders, examples, answers),
    }


def metric_values(split: dict[str, Any] | None) -> dict[str, float]:
    return {str(item["metric"]): float(item["value"]) for item in (split or {}).get("scores", [])}
