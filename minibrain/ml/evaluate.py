import statistics
from dataclasses import dataclass
from typing import Any

from minibrain.data.snapshot import Example, read_labels, read_split
from minibrain.ml.completion import Completion
from minibrain.ml.context import JobSpec, report, run_child, write_result
from minibrain.ml.devices import device_name
from minibrain.ml.runtime import Runtime
from minibrain.registry.models import VersionKind
from minibrain.registry.prices import DEVICE_TIME
from minibrain.registry.service import adapter_name
from minibrain.tasks.classify import build_messages, latency, score

BATCH_SIZE = 8
MAX_NEW_TOKENS = 24
REPORT_EVERY = 40


@dataclass(frozen=True)
class Pass:
    completions: list[Completion]
    batch_size: int
    seconds: float


def mean_of(values: list[int]) -> float:
    return statistics.mean(values) if values else 0.0


def measured_cost(run: Pass, device: str, name: str, pool: str | None) -> dict[str, Any]:
    return {
        "source": DEVICE_TIME,
        "pool": pool,
        "device": device,
        "device_name": name,
        "batch_size": run.batch_size,
        "requests": len(run.completions),
        "device_seconds": run.seconds,
        "prompt_tokens": mean_of([c.prompt_tokens for c in run.completions]),
        "completion_tokens": mean_of([c.completion_tokens for c in run.completions]),
    }


class Evaluation:
    def __init__(self, spec: JobSpec, runtime: Runtime, total: int) -> None:
        self.spec = spec
        self.runtime = runtime
        self.snapshot = spec.path("snapshot")
        self.labels = read_labels(self.snapshot)
        self.shots = read_split(self.snapshot, "shots")
        self.total = max(total, 1)
        self.done = 0
        self.adapter: str | None = None
        adapter_dir = spec.optional_path("adapter")
        if spec.raw["version_kind"] == VersionKind.LORA and adapter_dir is not None:
            self.adapter = adapter_name(spec.raw["slug"], int(spec.raw["number"]))
            runtime.ensure_adapter(self.adapter, adapter_dir)

    def prompts(self, examples: list[Example]) -> list[str]:
        kind = self.spec.raw["version_kind"]
        return [self.runtime.render(build_messages(kind, e.input, self.labels, self.shots)) for e in examples]

    def advance(self, count: int) -> None:
        self.done += count
        if self.done % REPORT_EVERY < count or self.done == self.total:
            report(self.done / self.total, evaluated=self.done, of=self.total)

    def run(self, examples: list[Example], batch_size: int) -> Pass:
        prompts = self.prompts(examples)
        completions: list[Completion] = []
        seconds = 0.0
        for start in range(0, len(prompts), batch_size):
            batch = self.runtime.generate(prompts[start : start + batch_size], self.adapter, MAX_NEW_TOKENS)
            completions += batch
            seconds += max((c.seconds for c in batch), default=0.0)
            self.advance(len(batch))
        return Pass(completions, batch_size, seconds)


def main(spec: JobSpec) -> None:
    snapshot = spec.path("snapshot")
    golden = read_split(snapshot, "golden")
    held_out = read_split(snapshot, "eval")
    runtime = Runtime(spec.base)
    evaluation = Evaluation(spec, runtime, len(golden) + len(held_out))
    runtime.generate(evaluation.prompts(golden[:1]), evaluation.adapter, MAX_NEW_TOKENS)
    golden_pass = evaluation.run(golden, batch_size=1)
    eval_pass = evaluation.run(held_out, batch_size=BATCH_SIZE)
    labels = evaluation.labels
    golden_completions = golden_pass.completions
    metrics = {
        "golden": score(golden, [c.text for c in golden_completions], labels),
        "eval": score(held_out, [c.text for c in eval_pass.completions], labels),
        "latency": latency([c.seconds for c in golden_completions]),
        "prompt_tokens": mean_of([c.prompt_tokens for c in golden_completions]),
        "device": runtime.device,
        "cost": measured_cost(eval_pass, runtime.device, device_name(runtime.device), spec.raw.get("pool")),
    }
    write_result(spec, {"metrics": metrics})
    report(1.0, latency=metrics["latency"], prompt_tokens=metrics["prompt_tokens"], device=metrics["device"])


if __name__ == "__main__":
    run_child(main)
