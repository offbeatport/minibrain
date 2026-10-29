from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass


@dataclass(frozen=True)
class Quality:
    rows: int
    empty: int
    duplicates: int
    labels: int
    smallest_label: int
    largest_label: int
    mean_input_chars: float


def is_blank(value: str | None) -> bool:
    return value is None or not value.strip()


def assess(rows: Sequence[tuple[str | None, str | None]]) -> Quality:
    usable = [
        (text.strip(), label.strip()) for text, label in rows if text and label and text.strip() and label.strip()
    ]
    per_label = Counter(label for _, label in usable)
    return Quality(
        rows=len(rows),
        empty=len(rows) - len(usable),
        duplicates=len(usable) - len({text for text, _ in usable}),
        labels=len(per_label),
        smallest_label=min(per_label.values(), default=0),
        largest_label=max(per_label.values(), default=0),
        mean_input_chars=sum(len(text) for text, _ in usable) / len(usable) if usable else 0.0,
    )
