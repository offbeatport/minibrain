import hashlib
import os
import shutil
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from minibrain.ml.context import emit

CHUNK = 1 << 20
REPORT_SECONDS = 1.0
SPEED_WINDOW = 5


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def valid(path: Path, entry: dict[str, Any]) -> bool:
    if not path.is_file() or path.stat().st_size != entry["size"]:
        return False
    return entry.get("sha256") is None or sha256_of(path) == entry["sha256"]


class Progress:
    def __init__(self, total: int, verb: str) -> None:
        self.total = max(total, 1)
        self.done = 0
        self.verb = verb
        self.reported = 0.0
        self.marks: list[tuple[float, int]] = []

    def speed(self, moment: float) -> float | None:
        self.marks = [*self.marks, (moment, self.done)][-SPEED_WINDOW:]
        (start, before), (end, after) = self.marks[0], self.marks[-1]
        return (after - before) / (end - start) if end > start else None

    def add(self, count: int, path: str) -> None:
        self.done += count
        moment = time.monotonic()
        if moment - self.reported >= REPORT_SECONDS or self.done >= self.total:
            self.reported = moment
            emit(
                "transfer.progress",
                f"{self.verb.capitalize()} {path}",
                progress=self.done / self.total,
                bytes=self.done,
                total=self.total,
                bytes_per_second=self.speed(moment),
                file=path,
            )


def write_stream(chunks: Iterator[bytes], target: Path, progress: Progress, name: str) -> str:
    digest = hashlib.sha256()
    partial = target.with_name(target.name + ".part")
    target.parent.mkdir(parents=True, exist_ok=True)
    with partial.open("wb") as stream:
        for chunk in chunks:
            stream.write(chunk)
            digest.update(chunk)
            progress.add(len(chunk), name)
    os.replace(partial, target)
    return digest.hexdigest()


def file_chunks(path: Path) -> Iterator[bytes]:
    with path.open("rb") as stream:
        while chunk := stream.read(CHUNK):
            yield chunk


def clear(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)
