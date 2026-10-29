import hashlib
import json
import random
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from functools import lru_cache
from pathlib import Path

GOLDEN_MAX = 50
EVAL_MAX = 500
SHOTS_MAX = 10
MIN_ROWS = 100
SEED = 7
SPLITS = ("golden", "eval", "shots", "train")


class SnapshotError(Exception):
    pass


@dataclass(frozen=True)
class Example:
    input: str
    label: str


@dataclass(frozen=True)
class SnapshotFiles:
    hash: str
    directory: Path
    counts: dict[str, int]
    labels: list[str]


def clean(rows: Sequence[tuple[str | None, str | None]]) -> list[Example]:
    examples: list[Example] = []
    seen: set[str] = set()
    for text, label in rows:
        if not text or not label or not text.strip() or not label.strip():
            continue
        example = Example(input=text.strip(), label=label.strip())
        if example.input not in seen:
            seen.add(example.input)
            examples.append(example)
    return examples


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


def split(examples: list[Example], seed: int = SEED) -> dict[str, list[Example]]:
    if len(examples) < MIN_ROWS:
        raise SnapshotError(f"need at least {MIN_ROWS} labelled rows after cleaning, found {len(examples)}")
    shuffled = examples[:]
    random.Random(seed).shuffle(shuffled)
    golden_size = min(GOLDEN_MAX, len(shuffled) // 10)
    eval_size = min(EVAL_MAX, len(shuffled) * 15 // 100)
    pool = shuffled[golden_size + eval_size :]
    shots = pick_shots(pool, SHOTS_MAX)
    shot_set = set(shots)
    return {
        "golden": shuffled[:golden_size],
        "eval": shuffled[golden_size : golden_size + eval_size],
        "shots": shots,
        "train": [example for example in pool if example not in shot_set],
    }


def content_hash(splits: dict[str, list[Example]]) -> str:
    payload = {name: [[example.input, example.label] for example in splits[name]] for name in SPLITS}
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def write(splits: dict[str, list[Example]], root: Path) -> SnapshotFiles:
    digest = content_hash(splits)
    directory = root / digest[:16]
    directory.mkdir(parents=True, exist_ok=True)
    for name in SPLITS:
        lines = "".join(json.dumps(asdict(example)) + "\n" for example in splits[name])
        (directory / f"{name}.jsonl").write_text(lines)
    labels = sorted({example.label for examples in splits.values() for example in examples})
    (directory / "labels.json").write_text(json.dumps(labels))
    counts = {name: len(splits[name]) for name in SPLITS}
    (directory / "manifest.json").write_text(json.dumps({"hash": digest, "counts": counts, "labels": len(labels)}))
    return SnapshotFiles(hash=digest, directory=directory, counts=counts, labels=labels)


def read_split(directory: Path, name: str) -> list[Example]:
    lines = (directory / f"{name}.jsonl").read_text().splitlines()
    return [Example(**json.loads(line)) for line in lines]


def read_labels(directory: Path) -> list[str]:
    return json.loads((directory / "labels.json").read_text())


@lru_cache(maxsize=64)
def prompt_context(directory: str) -> tuple[tuple[str, ...], tuple[Example, ...]]:
    path = Path(directory)
    return tuple(read_labels(path)), tuple(read_split(path, "shots"))
