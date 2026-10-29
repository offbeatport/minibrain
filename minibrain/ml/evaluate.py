import json
import statistics
import sys

from minibrain.data.snapshot import Example, read_labels, read_split
from minibrain.ml.completion import Completion
from minibrain.ml.context import JobContext, load_context, set_progress, update_version
from minibrain.ml.runtime import Runtime
from minibrain.registry.db import make_sessions
from minibrain.registry.models import VersionKind, VersionStatus
from minibrain.registry.service import adapter_name
from minibrain.settings import load_settings
from minibrain.tasks.classify import build_messages, latency, score

BATCH_SIZE = 8
MAX_NEW_TOKENS = 24


class Evaluation:
    def __init__(self, context: JobContext, runtime: Runtime, report: "Progress") -> None:
        self.context = context
        self.runtime = runtime
        self.report = report
        self.labels = read_labels(context.snapshot_dir)
        self.shots = read_split(context.snapshot_dir, "shots")
        self.adapter: str | None = None
        if context.version_kind == VersionKind.LORA and context.adapter_dir is not None:
            self.adapter = adapter_name(context.slug, context.number)
            runtime.ensure_adapter(self.adapter, context.adapter_dir)

    def prompts(self, examples: list[Example]) -> list[str]:
        kind = self.context.version_kind
        return [self.runtime.render(build_messages(kind, e.input, self.labels, self.shots)) for e in examples]

    def run(self, examples: list[Example], batch_size: int) -> list[Completion]:
        prompts = self.prompts(examples)
        completions: list[Completion] = []
        for start in range(0, len(prompts), batch_size):
            completions += self.runtime.generate(prompts[start : start + batch_size], self.adapter, MAX_NEW_TOKENS)
            self.report.advance(len(prompts[start : start + batch_size]))
        return completions


class Progress:
    def __init__(self, context: JobContext, total: int) -> None:
        self.sessions = make_sessions(load_settings().database_url)
        self.job_id = context.job_id
        self.total = max(total, 1)
        self.done = 0

    def advance(self, count: int) -> None:
        self.done += count
        if self.done % 40 < count or self.done == self.total:
            set_progress(self.sessions, self.job_id, self.done / self.total)
            print(json.dumps({"evaluated": self.done, "of": self.total}), flush=True)


def main(job_id: int) -> None:
    sessions = make_sessions(load_settings().database_url)
    context = load_context(sessions, job_id)
    golden = read_split(context.snapshot_dir, "golden")
    held_out = read_split(context.snapshot_dir, "eval")
    runtime = Runtime(context.spec)
    evaluation = Evaluation(context, runtime, Progress(context, len(golden) + len(held_out)))
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
    update_version(sessions, context.version_id, metrics=metrics, status=VersionStatus.READY)
    print(json.dumps({key: metrics[key] for key in ("latency", "prompt_tokens", "device")}), flush=True)


if __name__ == "__main__":
    main(int(sys.argv[1]))
