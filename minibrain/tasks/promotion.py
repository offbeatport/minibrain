import operator
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

OPERATORS: dict[str, Callable[[float, float], bool]] = {
    ">=": operator.ge,
    "<=": operator.le,
    ">": operator.gt,
    "<": operator.lt,
    "==": lambda left, right: abs(left - right) < 1e-9,
}
WRITTEN = re.compile(r"^\s*([A-Za-z_][\w.]*)\s*(>=|<=|==|>|<)\s*(-?\d+(?:\.\d+)?)\s*$")


class RuleError(ValueError):
    pass


@dataclass(frozen=True)
class Threshold:
    metric: str
    op: str
    value: float

    def __post_init__(self) -> None:
        if self.op not in OPERATORS:
            raise RuleError(f"a threshold compares with one of {', '.join(OPERATORS)}")
        if not re.fullmatch(r"[A-Za-z_][\w.]*", self.metric):
            raise RuleError("a threshold names a metric such as label_accuracy")

    def holds(self, actual: float) -> bool:
        return OPERATORS[self.op](actual, self.value)

    def text(self) -> str:
        return f"{self.metric} {self.op} {self.value:g}"

    def as_dict(self) -> dict[str, Any]:
        return {"metric": self.metric, "op": self.op, "value": self.value}

    @staticmethod
    def parse(item: Any) -> "Threshold":
        if isinstance(item, dict):
            return Threshold(str(item.get("metric", "")), str(item.get("op", "")), float(item.get("value", 0)))
        found = WRITTEN.match(str(item))
        if found is None:
            raise RuleError(f"{item!r} is not a threshold such as label_accuracy >= 0.85")
        return Threshold(found.group(1), found.group(2), float(found.group(3)))


@dataclass(frozen=True)
class Rule:
    thresholds: tuple[Threshold, ...] = ()
    beats_live: bool = True

    def as_dict(self) -> dict[str, Any]:
        return {"thresholds": [item.as_dict() for item in self.thresholds], "beats_live": self.beats_live}

    @staticmethod
    def from_dict(data: Mapping[str, Any] | None) -> "Rule":
        if not data:
            return Rule()
        items: Sequence[Any] = data.get("thresholds") or ()
        return Rule(tuple(Threshold.parse(item) for item in items), bool(data.get("beats_live", True)))


@dataclass(frozen=True)
class Check:
    name: str
    passed: bool
    detail: str
    actual: float | None = None

    def as_dict(self) -> dict[str, Any]:
        return {"name": self.name, "passed": self.passed, "detail": self.detail, "actual": self.actual}


@dataclass(frozen=True)
class Live:
    number: int
    metrics: Mapping[str, float] | None


@dataclass(frozen=True)
class Decision:
    passed: bool
    checks: tuple[Check, ...] = field(default_factory=tuple)

    def as_dict(self) -> dict[str, Any]:
        return {"passed": self.passed, "checks": [check.as_dict() for check in self.checks]}

    def reason(self) -> str:
        return "; ".join(f"{check.name}: {check.detail}" for check in self.checks if not check.passed)


def threshold_check(threshold: Threshold, metrics: Mapping[str, float] | None) -> Check:
    name = threshold.text()
    if metrics is None:
        return Check(name, False, "not scored yet")
    actual = metrics.get(threshold.metric)
    if actual is None:
        return Check(name, False, f"this version has no {threshold.metric} score")
    return Check(name, threshold.holds(actual), f"{threshold.metric} is {actual:.4g}", actual)


def live_check(main: str | None, metrics: Mapping[str, float] | None, live: Live | None) -> Check:
    name = "beats the live version"
    if live is None:
        return Check(name, True, "no version is live yet")
    if main is None:
        return Check(name, True, "no main metric to compare")
    theirs = (live.metrics or {}).get(main)
    if theirs is None:
        return Check(name, True, f"v{live.number} has no {main} score")
    mine = (metrics or {}).get(main)
    if mine is None:
        return Check(name, False, f"this version has no {main} score")
    return Check(name, mine >= theirs, f"{main} {mine:.4g} against {theirs:.4g} for v{live.number}", mine)


def decide(rule: Rule, metrics: Mapping[str, float] | None, main: str | None, live: Live | None) -> Decision:
    checks = [threshold_check(threshold, metrics) for threshold in rule.thresholds]
    if rule.beats_live:
        checks.append(live_check(main, metrics, live))
    return Decision(all(check.passed for check in checks), tuple(checks))
