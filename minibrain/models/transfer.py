import errno
import hashlib
import json
import os
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from minibrain.ml.context import FinalError, report
from minibrain.models import hub
from minibrain.models.files import Progress, file_chunks, sha256_of, valid
from minibrain.models.health import NEEDS_ACCESS, NO_SPACE, OFFLINE, SOURCE_GONE, content_hash
from minibrain.models.sources import FileSource, HubAccessError, HubGoneError, HubSource, StorageSource
from minibrain.storage import RESERVE_BYTES, disk_space, size_text

MANIFEST = "minibrain-model.json"

Fail = Callable[[str], Exception]
Ready = Callable[[list[dict[str, Any]]], None]


class ChecksumError(Exception):
    pass


def partial_of(target: Path) -> Path:
    return target.with_name(target.name + ".part")


def partial_size(target: Path, size: int) -> int:
    partial = partial_of(target)
    found = partial.stat().st_size if partial.is_file() else 0
    return found if found < size else 0


def check_room(out: Path, pending: list[dict[str, Any]]) -> None:
    needed = sum(int(entry["size"]) - partial_size(out / entry["path"], int(entry["size"])) for entry in pending)
    space = disk_space(out)
    if space is None or needed == 0 or needed + RESERVE_BYTES <= space.free:
        return
    raise FinalError(
        f"Needs {size_text(needed)}; {size_text(space.free)} free on the disk that holds models ({out}). "
        "Free up space, then resume; files already written are kept.",
        NO_SPACE,
    )


def disk_full(out: Path, path: str) -> FinalError:
    space = disk_space(out)
    free = size_text(space.free) if space else "no space"
    return FinalError(
        f"The disk filled up while writing {path} ({free} left on {out}). "
        "Free up space, then resume; files already written are kept.",
        NO_SPACE,
    )


def fetch(source: FileSource, entry: dict[str, Any], out: Path, progress: Progress) -> str:
    target = out / entry["path"]
    partial = partial_of(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    with source.opened(entry["path"], partial_size(target, int(entry["size"]))) as (start, chunks):
        if start:
            for chunk in file_chunks(partial):
                digest.update(chunk)
            progress.add(start, entry["path"])
        try:
            with partial.open("ab" if start else "wb") as stream:
                for chunk in chunks:
                    stream.write(chunk)
                    digest.update(chunk)
                    progress.add(len(chunk), entry["path"])
        except OSError as error:
            if error.errno == errno.ENOSPC:
                raise disk_full(out, entry["path"]) from error
            raise
    return digest.hexdigest()


def accept(entry: dict[str, Any], target: Path, digest: str, fail: Fail) -> None:
    partial = partial_of(target)
    size = partial.stat().st_size
    if size != entry["size"] or (entry.get("sha256") and digest != entry["sha256"]):
        partial.unlink(missing_ok=True)
        raise fail(
            f"{entry['path']} failed validation: expected {entry['size']} bytes and the saved SHA-256, got {size} bytes"
        )
    os.replace(partial, target)


def install(
    source: FileSource, files: list[dict[str, Any]], out: Path, verb: str, fail: Fail, ready: Ready
) -> tuple[list[dict[str, Any]], list[str]]:
    out.mkdir(parents=True, exist_ok=True)
    progress = Progress(sum(int(entry["size"]) for entry in files), verb)
    report(0.0, step="checking existing files")
    recorded: list[dict[str, Any]] = []
    pending: list[dict[str, Any]] = []
    for entry in files:
        target = out / entry["path"]
        if valid(target, entry):
            progress.add(int(entry["size"]), entry["path"])
            recorded.append(entry | {"sha256": entry.get("sha256") or sha256_of(target)})
        else:
            pending.append(entry)
    if pending:
        ready(pending)
        check_room(out, pending)
    for entry in pending:
        digest = fetch(source, entry, out, progress)
        accept(entry, out / entry["path"], digest, fail)
        recorded.append(entry | {"sha256": digest})
    return sorted(recorded, key=lambda item: item["path"]), [entry["path"] for entry in pending]


def write_manifest(out: Path, record: dict[str, Any]) -> None:
    files = record["files"]
    (out / MANIFEST).write_text(json.dumps(record | {"content_hash": content_hash(files)}, indent=1))


def gated_message(name: str, repo: str) -> str:
    return (
        f"{name} is gated. Accept its licence at {hub.endpoint()}/{repo} "
        "and set HF_TOKEN on the minibrain server, then retry."
    )


def access_message(repo: str, error: HubAccessError) -> str:
    page = f"{hub.endpoint()}/{repo}"
    if error.status == 401:
        return (
            f"{hub.endpoint()} refused {error.path} of {repo} (401): HF_TOKEN on the minibrain server is missing, "
            f"wrong or expired. Accept the licence at {page}, set a valid HF_TOKEN, then retry."
        )
    return (
        f"{hub.endpoint()} refused {error.path} of {repo} (403): the account behind HF_TOKEN has no access. "
        f"Accept the licence at {page} with that account, then retry."
    )


def gone_message(repo: str, revision: str, error: HubGoneError) -> str:
    return (
        f"{error.path} is no longer published at {repo}@{revision[:12]} on {hub.endpoint()}. "
        "Re-import the files from a folder or S3 path; the local copy stays usable if it verifies."
    )


@contextmanager
def hub_errors(repo: str, revision: str) -> Iterator[None]:
    try:
        yield
    except HubAccessError as error:
        raise FinalError(access_message(repo, error), NEEDS_ACCESS) from error
    except HubGoneError as error:
        raise FinalError(gone_message(repo, revision, error), SOURCE_GONE) from error


def hub_ready(source: HubSource, name: str, gated: bool, offline: str) -> Ready:
    def check(pending: list[dict[str, Any]]) -> None:
        if all(source.cached(entry["path"]) is not None for entry in pending):
            return
        if hub.offline():
            raise FinalError(offline, OFFLINE)
        if gated and hub.token() is None:
            raise FinalError(gated_message(name, source.repo), NEEDS_ACCESS)

    return check


def storage_ready(source: StorageSource, name: str) -> Ready:
    def check(pending: list[dict[str, Any]]) -> None:
        for entry in pending:
            found = source.size(entry["path"])
            if found is None:
                raise FinalError(f"{entry['path']} is not in {source.url}; use a copy that holds every file of {name}")
            if found != entry["size"]:
                raise FinalError(
                    f"{entry['path']} in {source.url} is {found} bytes, expected {entry['size']}: this copy holds "
                    "different files. Import it as a new model instead."
                )

    return check


def different_copy(message: str) -> Exception:
    return FinalError(f"{message}. This copy holds different files; import it as a new model instead.")
