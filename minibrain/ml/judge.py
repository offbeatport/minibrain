from minibrain.ml.context import JobSpec, report, run_child, write_result
from minibrain.ml.runtime import Runtime
from minibrain.tasks.judge import GRADES, Item, grade_value, messages_for

BATCH_SIZE = 8


def main(spec: JobSpec) -> None:
    items = [Item.from_dict(item) for item in spec.raw["items"]]
    rubric = str(spec.raw["rubric"])
    runtime = Runtime(spec.base)
    scores: dict[str, float] = {}
    for start in range(0, len(items), BATCH_SIZE):
        batch = items[start : start + BATCH_SIZE]
        prompts = [runtime.render(messages_for(rubric, item)) for item in batch]
        for item, completion in zip(batch, runtime.generate(prompts, None, 2, GRADES), strict=True):
            value = grade_value(completion.text)
            if value is not None:
                scores[item.key] = value
        report((start + len(batch)) / max(len(items), 1), judged=start + len(batch), of=len(items))
    write_result(spec, {"scores": scores})


if __name__ == "__main__":
    run_child(main)
