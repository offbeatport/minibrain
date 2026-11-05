import re
from collections.abc import Iterable
from itertools import count
from pathlib import Path

from minibrain.data.sources import READERS

NUMBERED = re.compile(r" \(\d+\)$")


def same_name(first: str, second: str) -> bool:
    return first.strip().casefold() == second.strip().casefold()


def split_suffix(name: str) -> tuple[str, str]:
    suffix = Path(name).suffix
    if suffix.lower() in READERS and len(name) > len(suffix):
        return name[: -len(suffix)], suffix
    return name, ""


def free_name(name: str, taken: Iterable[str]) -> str:
    folded = {item.strip().casefold() for item in taken}
    if name.strip().casefold() not in folded:
        return name
    stem, suffix = split_suffix(name)
    base = NUMBERED.sub("", stem)
    candidates = (f"{base} ({number}){suffix}" for number in count(2))
    return next(candidate for candidate in candidates if candidate.casefold() not in folded)
