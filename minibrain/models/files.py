import hashlib
import os
import shutil
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

from minibrain.ml.context import report

CHUNK = 1 << 20
REPORT_SECONDS = 1.0


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

    def add(self, count: int, path: str) -> None:
        self.done += count
        if time.monotonic() - self.reported >= REPORT_SECONDS or self.done >= self.total:
            self.reported = time.monotonic()
            report(self.done / self.total, step=f"{self.verb} {path}", bytes=self.done, total=self.total)


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


def check(entry: dict[str, Any], target: Path, digest: str, fail: Callable[[str], Exception]) -> None:
    size = target.stat().st_size
    if size != entry["size"] or (entry.get("sha256") and digest != entry["sha256"]):
        target.unlink(missing_ok=True)
        raise fail(f"{entry['path']} failed validation: expected {entry['size']} bytes and the published SHA-256")


def clear(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)
