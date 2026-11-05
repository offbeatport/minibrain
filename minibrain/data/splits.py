import random
from collections import Counter
from collections.abc import Sequence
from functools import lru_cache
from pathlib import Path

import duckdb

from minibrain.encryption.duck import register
from minibrain.tasks.contracts import MAX_LABELS
from minibrain.tasks.examples import ASSISTANT, Example, Turn, turns_of, well_formed

GOLDEN_MAX = 50
EVAL_MAX = 500
SHOTS_MAX = 10
TEXT_SHOTS = 3
MIN_ROWS = 100
SEED = 7
SPLITS = ("golden", "eval", "shots", "train")
LABEL_CHARS = 100

Row = tuple[str | None, str | None, str | None]


class DatasetVersionError(Exception):
    pass


def example_of(messages: str | None, text: str | None, expected: str | None) -> Example | None:
    if not text or not expected or not text.strip() or not expected.strip() or not messages:
        return None
    turns = turns_of(messages)
    if not turns or not well_formed([*turns, Turn(ASSISTANT, expected)]):
        return None
    return Example(turns=turns, expected=expected.strip())


def clean(rows: Sequence[Row]) -> list[Example]:
    examples: list[Example] = []
    seen: set[str] = set()
    for messages, text, expected in rows:
        example = example_of(messages, text, expected)
        if example is not None and example.input not in seen:
            seen.add(example.input)
            examples.append(example)
    return examples


def pairs(rows: Sequence[Row]) -> list[tuple[str | None, str | None]]:
    return [(text, expected) for _, text, expected in rows]


def answer_labels(examples: Sequence[Example]) -> list[str]:
    counts = Counter(example.expected for example in examples)
    short = all(len(label) <= LABEL_CHARS and "\n" not in label for label in counts)
    if not counts or not short or len(counts) > MAX_LABELS or 2 * len(counts) > len(examples):
        return []
    return sorted(counts)


def pick_shots(pool: list[Example], labelled: bool) -> list[Example]:
    if not labelled:
        return pool[:TEXT_SHOTS]
    shots: list[Example] = []
    seen: set[str] = set()
    for example in pool:
        if example.expected not in seen:
            shots.append(example)
            seen.add(example.expected)
        if len(shots) == SHOTS_MAX:
            break
    return shots


def split(examples: list[Example], seed: int = SEED) -> dict[str, list[Example]]:
    if len(examples) < MIN_ROWS:
        raise DatasetVersionError(f"need at least {MIN_ROWS} labelled rows after cleaning, found {len(examples)}")
    shuffled = examples[:]
    random.Random(seed).shuffle(shuffled)
    golden_size = min(GOLDEN_MAX, len(shuffled) // 10)
    eval_size = min(EVAL_MAX, len(shuffled) * 15 // 100)
    pool = shuffled[golden_size + eval_size :]
    shots = pick_shots(pool, bool(answer_labels(examples)))
    shot_set = set(shots)
    return {
        "golden": shuffled[:golden_size],
        "eval": shuffled[golden_size : golden_size + eval_size],
        "shots": shots,
        "train": [example for example in pool if example not in shot_set],
    }


def read_rows(path: Path | str) -> list[Row]:
    with duckdb.connect() as connection:
        register(connection)
        found = connection.execute(
            "SELECT CAST(messages AS VARCHAR), CAST(input AS VARCHAR), CAST(expected AS VARCHAR) FROM read_parquet(?)",
            [str(path)],
        ).fetchall()
    return [(messages, text, expected) for messages, text, expected in found]


@lru_cache(maxsize=8)
def parquet_splits(path: str) -> dict[str, list[Example]]:
    return split(clean(read_rows(path)))


def labels_of(splits: dict[str, list[Example]]) -> list[str]:
    return answer_labels([example for examples in splits.values() for example in examples])


def read_split(path: Path | str, name: str) -> list[Example]:
    return list(parquet_splits(str(path))[name])
