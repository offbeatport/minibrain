import json
import os
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import duckdb

from minibrain.data.remote import RemoteState, digest
from minibrain.data.sources import SourceError, quote_literal

DELTA = "delta"
LOG = "_delta_log"
HEAD_BYTES = 1 << 16
COMMIT = re.compile(r"^(\d{20})\.json$")
CHECKPOINT = re.compile(r"^(\d{20})\.checkpoint(?:\.\d+\.\d+|\.[0-9a-fA-F-]{36})?\.(?:parquet|json)$")
NOT_FIPS_READY = (
    "Delta tables are read from folders on this server only. DuckDB's delta extension reads a table's log through "
    "its own HTTP and TLS client (delta-kernel-rs with rustls and ring), outside OpenSSL, so reading one from S3 or "
    "HTTPS is not FIPS-ready. Mount the bucket on the server, or copy the table into a folder under Settings, "
    "Security, Folder sources."
)


@dataclass(frozen=True)
class DeltaReader:
    root: str
    version: int

    @property
    def extensions(self) -> tuple[str, ...]:
        return (DELTA,)

    @property
    def paths(self) -> tuple[str, ...]:
        return ()

    @property
    def directories(self) -> tuple[str, ...]:
        return (f"{self.root}/",)

    def open(self, connection: duckdb.DuckDBPyConnection, alias: str) -> str:
        return f"SELECT * FROM delta_scan({quote_literal(self.root)}, version = {int(self.version)})"


@dataclass(frozen=True)
class LogEntry:
    version: int
    path: Path


def refuse_remote(path: str) -> None:
    cleaned = path.strip()
    if "://" in cleaned and not cleaned.lower().startswith("file://"):
        raise SourceError(NOT_FIPS_READY)


def local_path(path: str) -> str:
    cleaned = path.strip()
    return cleaned[len("file://") :] if cleaned.lower().startswith("file://") else cleaned


def log_folder(root: Path) -> Path:
    folder = root / LOG
    if folder.is_symlink():
        raise SourceError(f"{folder} is a symbolic link; minibrain reads a Delta log only inside the table's folder")
    if not folder.is_dir():
        raise SourceError(f"{root} has no {LOG} folder; give the Delta table's own folder")
    return folder


def newest(folder: Path) -> tuple[LogEntry | None, LogEntry | None]:
    commit: LogEntry | None = None
    checkpoint: LogEntry | None = None
    with os.scandir(folder) as entries:
        for entry in entries:
            if found := COMMIT.match(entry.name):
                version = int(found.group(1))
                if commit is None or version > commit.version:
                    commit = LogEntry(version, Path(entry.path))
            elif found := CHECKPOINT.match(entry.name):
                version = int(found.group(1))
                if checkpoint is None or version > checkpoint.version:
                    checkpoint = LogEntry(version, Path(entry.path))
    return commit, checkpoint


def commit_time(path: Path) -> datetime | None:
    try:
        with path.open("rb") as stream:
            head = stream.read(HEAD_BYTES)
    except OSError:
        return None
    for line in head.splitlines():
        try:
            action = json.loads(line)
        except ValueError:
            continue
        info = action.get("commitInfo") if isinstance(action, dict) else None
        stamp = info.get("inCommitTimestamp", info.get("timestamp")) if isinstance(info, dict) else None
        if isinstance(stamp, int):
            return datetime.fromtimestamp(stamp / 1000, UTC)
    return None


def delta_state(root: Path) -> RemoteState:
    commit, checkpoint = newest(log_folder(root))
    use_commit = commit is not None and (checkpoint is None or commit.version >= checkpoint.version)
    entry = commit if use_commit else checkpoint
    if entry is None:
        raise SourceError(f"{root / LOG} has no commits; the Delta table has not been written yet")
    try:
        found = entry.path.stat()
    except OSError as error:
        raise SourceError(f"could not read {entry.path}: {error.strerror or error}") from error
    stamp = commit_time(entry.path) if use_commit else None
    written = f"{entry.path.name}\t{found.st_size}\t{found.st_mtime_ns}"
    return RemoteState(
        fingerprint=f"v{entry.version}-{digest([str(root), str(entry.version), written])}",
        detail=f"Version {entry.version}; changes are tracked by the table version",
        modified_at=stamp or datetime.fromtimestamp(found.st_mtime, UTC),
        reader=DeltaReader(root=str(root), version=entry.version),
    )
