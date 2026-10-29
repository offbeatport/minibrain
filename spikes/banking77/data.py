import json
import random
from dataclasses import asdict, dataclass

from datasets import ClassLabel, Dataset, load_dataset

from spikes.banking77.config import DATA_DIR, DATASET_ID, DATASET_REVISION, EVAL_SIZE, GOLDEN_SIZE, SEED, SHOT_COUNT


@dataclass(frozen=True)
class Example:
    text: str
    label: str


def load_split(split: str) -> Dataset:
    dataset = load_dataset(DATASET_ID, revision=DATASET_REVISION, split=split)
    if not isinstance(dataset, Dataset):
        raise TypeError(f"expected a Dataset for split {split}, got {type(dataset).__name__}")
    return dataset


def label_names(dataset: Dataset) -> list[str]:
    feature = dataset.features["label"]
    if not isinstance(feature, ClassLabel):
        raise TypeError(f"expected ClassLabel, got {type(feature).__name__}")
    return feature.names


def to_examples(dataset: Dataset, labels: list[str]) -> list[Example]:
    return [Example(text=row["text"], label=labels[row["label"]]) for row in dataset.to_list()]


def pick_shots(pool: list[Example], count: int) -> list[Example]:
    shots: list[Example] = []
    seen: set[str] = set()
    for example in pool:
        if example.label not in seen:
            shots.append(example)
            seen.add(example.label)
        if len(shots) == count:
            break
    return shots


def write_examples(name: str, examples: list[Example]) -> None:
    lines = "".join(json.dumps(asdict(example)) + "\n" for example in examples)
    (DATA_DIR / f"{name}.jsonl").write_text(lines)


def read_examples(name: str) -> list[Example]:
    lines = (DATA_DIR / f"{name}.jsonl").read_text().splitlines()
    return [Example(**json.loads(line)) for line in lines]


def read_labels() -> list[str]:
    return json.loads((DATA_DIR / "labels.json").read_text())


def build() -> None:
    train_split = load_split("train")
    labels = label_names(train_split)
    train = to_examples(train_split, labels)
    test = to_examples(load_split("test"), labels)
    rng = random.Random(SEED)
    rng.shuffle(train)
    rng.shuffle(test)
    shots = pick_shots(train, SHOT_COUNT)
    splits = {
        "golden": test[:GOLDEN_SIZE],
        "eval": test[GOLDEN_SIZE : GOLDEN_SIZE + EVAL_SIZE],
        "shots": shots,
        "train": [example for example in train if example not in shots],
    }
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    for name, examples in splits.items():
        write_examples(name, examples)
    (DATA_DIR / "labels.json").write_text(json.dumps(labels))
    print(f"labels={len(labels)} " + " ".join(f"{name}={len(examples)}" for name, examples in splits.items()))


if __name__ == "__main__":
    build()
