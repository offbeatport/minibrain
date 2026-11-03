import hashlib
import json
import random
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from functools import lru_cache
from pathlib import Path

import duckdb

from minibrain.encryption.duck import is_sealed_url, register

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


def write(splits: dict[str, list[Example]], directory: Path) -> SnapshotFiles:
    digest = content_hash(splits)
    directory.mkdir(parents=True, exist_ok=True)
    for name in SPLITS:
        lines = "".join(json.dumps(asdict(example)) + "\n" for example in splits[name])
        (directory / f"{name}.jsonl").write_text(lines)
    labels = sorted({example.label for examples in splits.values() for example in examples})
    (directory / "labels.json").write_text(json.dumps(labels))
    counts = {name: len(splits[name]) for name in SPLITS}
    (directory / "manifest.json").write_text(json.dumps({"hash": digest, "counts": counts, "labels": len(labels)}))
    return SnapshotFiles(hash=digest, directory=directory, counts=counts, labels=labels)


def read_rows(path: Path | str) -> list[tuple[str | None, str | None]]:
    with duckdb.connect() as connection:
        register(connection)
        found = connection.execute(
            "SELECT CAST(input AS VARCHAR), CAST(label AS VARCHAR) FROM read_parquet(?)", [str(path)]
        ).fetchall()
    return [(text, label) for text, label in found]


@lru_cache(maxsize=8)
def parquet_splits(path: str) -> dict[str, list[Example]]:
    return split(clean(read_rows(path)))


def is_parquet(location: str) -> bool:
    return is_sealed_url(location) or Path(location).is_file()


def labels_of(splits: dict[str, list[Example]]) -> list[str]:
    return sorted({example.label for examples in splits.values() for example in examples})


def read_split(path: Path | str, name: str) -> list[Example]:
    location = str(path)
    if is_parquet(location):
        return list(parquet_splits(location)[name])
    lines = (Path(location) / f"{name}.jsonl").read_text().splitlines()
    return [Example(**json.loads(line)) for line in lines]


def read_labels(path: Path | str) -> list[str]:
    location = str(path)
    if is_parquet(location):
        return labels_of(parquet_splits(location))
    return json.loads((Path(location) / "labels.json").read_text())


@lru_cache(maxsize=64)
def prompt_context(location: str) -> tuple[tuple[str, ...], tuple[Example, ...]]:
    return tuple(read_labels(location)), tuple(read_split(location, "shots"))
