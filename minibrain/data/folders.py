import hashlib
import os
from collections import Counter
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy.orm import Session

from minibrain.data.sources import READERS, SourceError
from minibrain.policy import load

MAX_FILES = 10_000
FAMILIES = ((".csv",), (".tsv",), (".json",), (".jsonl", ".ndjson"), (".parquet",))


@dataclass(frozen=True)
class FolderFile:
    path: str
    size: int
    modified: int


@dataclass(frozen=True)
class FolderScan:
    root: Path
    format: str
    files: tuple[FolderFile, ...]

    @property
    def size(self) -> int:
        return sum(item.size for item in self.files)

    @property
    def modified_at(self) -> datetime | None:
        newest = max((item.modified for item in self.files), default=None)
        return None if newest is None else datetime.fromtimestamp(newest / 1e9, UTC)

    @property
    def fingerprint(self) -> str:
        digest = hashlib.sha256()
        for item in self.files:
            relative = os.path.relpath(item.path, self.root)
            digest.update(f"{relative}\t{item.size}\t{item.modified}\n".encode())
        return digest.hexdigest()


def allowed_roots(session: Session) -> list[Path]:
    return [Path(item).expanduser().resolve() for item in load(session)["data_folders"] if str(item).strip()]


def inside(path: Path, roots: list[Path]) -> bool:
    return any(path == root or path.is_relative_to(root) for root in roots)


def check_folder(session: Session, path: str) -> Path:
    roots = allowed_roots(session)
    if not roots:
        raise SourceError("no folders are allowed yet: add one under Settings, Security, Folder sources")
    candidate = Path(path.strip()).expanduser()
    if not candidate.is_absolute():
        raise SourceError("give the folder's full path, starting with /")
    resolved = candidate.resolve()
    if not inside(resolved, roots):
        listed = ", ".join(str(root) for root in roots)
        raise SourceError(f"{resolved} is outside the folders minibrain may read: {listed}")
    if not resolved.is_dir():
        raise SourceError(f"{resolved} is not a folder on this server")
    return resolved


def family(suffix: str) -> tuple[str, ...]:
    return next((group for group in FAMILIES if suffix in group), (suffix,))


def walk(root: Path) -> Iterator[tuple[Path, os.stat_result]]:
    for directory, folders, names in os.walk(root, followlinks=False):
        folders[:] = sorted(name for name in folders if not name.startswith("."))
        for name in sorted(names):
            if name.startswith("."):
                continue
            path = Path(directory) / name
            if path.is_symlink():
                continue
            found = path.stat()
            if path.is_file():
                yield path, found


def detect_format(root: Path) -> str:
    counts = Counter(family(path.suffix.lower())[0] for path, _ in walk(root) if path.suffix.lower() in READERS)
    if not counts:
        raise SourceError(f"{root} has no CSV, TSV, JSON, JSON Lines or Parquet files")
    return counts.most_common(1)[0][0]


def scan(root: Path, format: str) -> FolderScan:
    suffixes = family(format)
    files: list[FolderFile] = []
    for path, found in walk(root):
        if path.suffix.lower() not in suffixes:
            continue
        files.append(FolderFile(path=str(path), size=found.st_size, modified=found.st_mtime_ns))
        if len(files) > MAX_FILES:
            raise SourceError(f"{root} has more than {MAX_FILES:,} {format} files; point at a narrower folder")
    if not files:
        raise SourceError(f"{root} has no {format} files any more")
    return FolderScan(root=root, format=format, files=tuple(files))
