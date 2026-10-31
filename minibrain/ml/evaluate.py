import statistics

from minibrain.data.snapshot import Example, read_labels, read_split
from minibrain.ml.completion import Completion
from minibrain.ml.context import JobSpec, report, run_child, write_result
from minibrain.ml.runtime import Runtime
from minibrain.registry.models import VersionKind
from minibrain.registry.service import adapter_name
from minibrain.tasks.classify import build_messages, latency, score

BATCH_SIZE = 8
MAX_NEW_TOKENS = 24
REPORT_EVERY = 40


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

    def run(self, examples: list[Example], batch_size: int) -> list[Completion]:
        prompts = self.prompts(examples)
        completions: list[Completion] = []
        for start in range(0, len(prompts), batch_size):
            batch = prompts[start : start + batch_size]
            completions += self.runtime.generate(batch, self.adapter, MAX_NEW_TOKENS)
            self.advance(len(batch))
        return completions


def main(spec: JobSpec) -> None:
    snapshot = spec.path("snapshot")
    golden = read_split(snapshot, "golden")
    held_out = read_split(snapshot, "eval")
    runtime = Runtime(spec.base)
    evaluation = Evaluation(spec, runtime, len(golden) + len(held_out))
    runtime.generate(evaluation.prompts(golden[:1]), evaluation.adapter, MAX_NEW_TOKENS)
    golden_completions = evaluation.run(golden, batch_size=1)
    eval_completions = evaluation.run(held_out, batch_size=BATCH_SIZE)
    labels = evaluation.labels
    metrics = {
        "golden": score(golden, [c.text for c in golden_completions], labels),
        "eval": score(held_out, [c.text for c in eval_completions], labels),
        "latency": latency([c.seconds for c in golden_completions]),
        "prompt_tokens": statistics.mean(c.prompt_tokens for c in golden_completions) if golden_completions else 0,
        "device": runtime.device,
    }
    write_result(spec, {"metrics": metrics})
    report(1.0, latency=metrics["latency"], prompt_tokens=metrics["prompt_tokens"], device=metrics["device"])


if __name__ == "__main__":
    run_child(main)
