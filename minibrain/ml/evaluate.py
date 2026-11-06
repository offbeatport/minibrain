import statistics
from collections.abc import Sequence
from dataclasses import dataclass, replace
from typing import Any

from minibrain.data.splits import read_split
from minibrain.ml.completion import Completion
from minibrain.ml.context import JobSpec, emit, run_child, write_result
from minibrain.ml.devices import device_name
from minibrain.ml.runtime import Runtime
from minibrain.registry.models import VersionKind
from minibrain.registry.prices import DEVICE_TIME
from minibrain.registry.service import adapter_name
from minibrain.serve.dialects import answer_text
from minibrain.tasks.examples import Example
from minibrain.tasks.prompting import Prompting

BATCH_SIZE = 8
ANSWER_TOKENS = 24
REPORT_EVERY = 40


@dataclass(frozen=True)
class Pass:
    completions: list[Completion]
    batch_size: int
    seconds: float


def mean_of(values: list[int]) -> float:
    return statistics.mean(values) if values else 0.0


def latency(seconds: Sequence[float]) -> dict[str, float]:
    milliseconds = [value * 1000 for value in seconds]
    if len(milliseconds) < 2:
        value = milliseconds[0] if milliseconds else 0.0
        return {"p50_ms": value, "p95_ms": value}
    return {
        "p50_ms": statistics.median(milliseconds),
        "p95_ms": statistics.quantiles(milliseconds, n=20, method="inclusive")[-1],
    }


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
        self.prompting = Prompting.from_dict(spec.raw["prompting"])
        constraint = self.prompting.constraint()
        self.choices = constraint.options() if constraint is not None else ()
        self.max_tokens = int(spec.raw.get("answer_tokens") or ANSWER_TOKENS)
        self.total = max(total, 1)
        self.done = 0
        self.adapter: str | None = None
        adapter_dir = spec.optional_path("adapter")
        if spec.raw["version_kind"] == VersionKind.LORA and adapter_dir is not None:
            self.adapter = adapter_name(spec.raw["slug"], int(spec.raw["number"]))
            runtime.ensure_adapter(self.adapter, adapter_dir)

    def prompts(self, examples: list[Example]) -> list[str]:
        return [self.runtime.render(self.prompting.messages(example.messages())) for example in examples]

    def advance(self, count: int) -> None:
        self.done += count
        if self.done % REPORT_EVERY < count or self.done == self.total:
            emit(
                "score.progress",
                f"Answered {self.done} of {self.total} rows",
                progress=self.done / self.total,
                done=self.done,
                total=self.total,
            )

    def generate(self, prompts: list[str]) -> list[Completion]:
        found = self.runtime.generate(prompts, self.adapter, self.max_tokens, self.choices)
        return [replace(completion, text=answer_text(self.runtime.spec, completion.text)) for completion in found]

    def run(self, examples: list[Example], batch_size: int) -> Pass:
        prompts = self.prompts(examples)
        completions: list[Completion] = []
        seconds = 0.0
        for start in range(0, len(prompts), batch_size):
            batch = self.generate(prompts[start : start + batch_size])
            completions += batch
            seconds += max((c.seconds for c in batch), default=0.0)
            self.advance(len(batch))
        return Pass(completions, batch_size, seconds)


def main(spec: JobSpec) -> None:
    dataset_version = spec.path("dataset_version")
    golden = read_split(dataset_version, "golden")
    held_out = read_split(dataset_version, "eval")
    runtime = Runtime(spec.base)
    evaluation = Evaluation(spec, runtime, len(golden) + len(held_out))
    evaluation.generate(evaluation.prompts(golden[:1]))
    golden_pass = evaluation.run(golden, batch_size=1)
    eval_pass = evaluation.run(held_out, batch_size=BATCH_SIZE)
    golden_completions = golden_pass.completions
    metrics = {
        "latency": latency([c.seconds for c in golden_completions]),
        "prompt_tokens": mean_of([c.prompt_tokens for c in golden_completions]),
        "device": runtime.device,
        "decoding": "constrained" if evaluation.choices else "free",
        "cost": measured_cost(eval_pass, runtime.device, device_name(runtime.device), spec.raw.get("pool")),
    }
    answers = {"golden": [c.text for c in golden_completions], "eval": [c.text for c in eval_pass.completions]}
    write_result(spec, {"metrics": metrics, "answers": answers})
    emit(
        "score.done",
        f"Answered {evaluation.done} rows on {runtime.device}",
        progress=1.0,
        latency=metrics["latency"],
        prompt_tokens=metrics["prompt_tokens"],
        device=metrics["device"],
    )


if __name__ == "__main__":
    run_child(main)
