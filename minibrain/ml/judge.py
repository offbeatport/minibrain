from minibrain.ml.context import JobSpec, report, run_child, write_result
from minibrain.ml.runtime import Runtime
from minibrain.serve.dialects import answer_text
from minibrain.tasks.judge import Item, grade_value, messages_for, reason_of

BATCH_SIZE = 8
VERDICT_TOKENS = 64


def main(spec: JobSpec) -> None:
    items = [Item.from_dict(item) for item in spec.raw["items"]]
    rubric = str(spec.raw["rubric"])
    instructions = str(spec.raw.get("instructions") or "")
    runtime = Runtime(spec.base)
    scores: dict[str, float] = {}
    reasons: dict[str, str] = {}
    for start in range(0, len(items), BATCH_SIZE):
        batch = items[start : start + BATCH_SIZE]
        prompts = [runtime.render(messages_for(rubric, item, instructions)) for item in batch]
        for item, completion in zip(batch, runtime.generate(prompts, None, VERDICT_TOKENS), strict=True):
            text = answer_text(runtime.spec, completion.text)
            value = grade_value(text)
            if value is None:
                continue
            scores[item.key] = value
            reason = reason_of(text)
            if reason:
                reasons[item.key] = reason
        report((start + len(batch)) / max(len(items), 1), judged=start + len(batch), of=len(items))
    write_result(spec, {"scores": scores, "reasons": reasons})


if __name__ == "__main__":
    run_child(main)
