import base64
import hashlib
import json
import os
import shutil
import tempfile
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, contextmanager
from pathlib import Path
from typing import Any

import httpx

from minibrain.artifacts import StreamReader
from minibrain.encryption.envelope import CHUNK, HEADER, open_chunks, parse_header, plain_chunks, read_exact
from minibrain.models.files import sha256_of

MANIFEST = "minibrain-model.json"
FOLDER = "folder"
BUCKET = "s3"
BUCKET_TIMEOUT = httpx.Timeout(60.0, connect=10.0)

Opener = Callable[[dict[str, Any]], AbstractContextManager[Iterator[bytes]]]


class CopyError(Exception):
    pass


def bucket_client() -> httpx.Client:
    return httpx.Client(timeout=BUCKET_TIMEOUT, follow_redirects=False)


def file_entry(entry: dict[str, Any]) -> dict[str, Any]:
    return {"path": str(entry["path"]), "size": int(entry["size"]), "sha256": entry.get("sha256")}


def read_manifest(folder: Path) -> dict[str, Any]:
    try:
        found = json.loads((folder / MANIFEST).read_text())
    except (OSError, ValueError):
        return {}
    return found if isinstance(found, dict) else {}


def write_manifest(folder: Path, content_hash: str | None, files: list[dict[str, Any]]) -> None:
    record = {"working_copy": True, "content_hash": content_hash, "files": [file_entry(entry) for entry in files]}
    descriptor, name = tempfile.mkstemp(dir=folder, prefix=f".{MANIFEST}.")
    with os.fdopen(descriptor, "w") as stream:
        stream.write(json.dumps(record, indent=1))
    os.replace(name, folder / MANIFEST)


def known_hashes(folder: Path, content_hash: str | None) -> dict[str, str]:
    manifest = read_manifest(folder)
    if content_hash is None or manifest.get("content_hash") != content_hash:
        return {}
    return {str(entry["path"]): str(entry["sha256"]) for entry in manifest.get("files", []) if entry.get("sha256")}


def current(target: Path, entry: dict[str, Any], known: dict[str, str]) -> bool:
    if not target.is_file() or target.stat().st_size != int(entry["size"]):
        return False
    expected = entry.get("sha256")
    if not expected or known.get(str(entry["path"])) == expected:
        return True
    return sha256_of(target) == expected


def matches(folder: Path, files: list[dict[str, Any]], content_hash: str | None) -> bool:
    known = known_hashes(folder, content_hash)
    return bool(known) and all(
        (folder / str(entry["path"])).is_file()
        and (folder / str(entry["path"])).stat().st_size == int(entry["size"])
        and known.get(str(entry["path"])) == entry.get("sha256")
        for entry in files
    )


def fetch(target: Path, entry: dict[str, Any], opener: Opener) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(dir=target.parent, prefix=f".{target.name}.")
    digest = hashlib.sha256()
    size = 0
    try:
        with os.fdopen(descriptor, "wb") as out, opener(entry) as chunks:
            for chunk in chunks:
                out.write(chunk)
                digest.update(chunk)
                size += len(chunk)
        expected = entry.get("sha256")
        if size != int(entry["size"]) or (expected and digest.hexdigest() != expected):
            raise CopyError(f"{entry['path']} arrived as {size} bytes that do not match the saved SHA-256")
        os.replace(name, target)
    finally:
        Path(name).unlink(missing_ok=True)


def ensure(folder: Path, files: list[dict[str, Any]], opener: Opener, content_hash: str | None) -> list[str]:
    manifest = read_manifest(folder)
    if manifest.get("working_copy") and content_hash and manifest.get("content_hash") != content_hash:
        shutil.rmtree(folder, ignore_errors=True)
    folder.mkdir(parents=True, exist_ok=True)
    known = known_hashes(folder, content_hash)
    fetched = []
    for entry in files:
        target = folder / str(entry["path"])
        if not target.resolve().is_relative_to(folder.resolve()):
            raise CopyError(f"{entry['path']} is outside the model's folder")
        if current(target, entry, known):
            continue
        fetch(target, entry, opener)
        fetched.append(str(entry["path"]))
    write_manifest(folder, content_hash, files)
    return fetched


def stale(folder: Path, live: dict[str, str | None], key: str) -> bool:
    manifest = read_manifest(folder)
    if not manifest.get("working_copy"):
        return False
    if key not in live:
        return True
    expected = live[key]
    return expected is not None and manifest.get("content_hash") != expected


def prune(root: Path, live: dict[str, str | None], weights_of: Callable[[Path], Path]) -> list[str]:
    if not root.is_dir():
        return []
    removed = []
    for entry in sorted(root.iterdir()):
        folder = weights_of(entry)
        if entry.is_dir() and stale(folder, live, entry.name):
            shutil.rmtree(folder, ignore_errors=True)
            removed.append(entry.name)
    return removed


@contextmanager
def bucket_chunks(http: httpx.Client, entry: dict[str, Any]) -> Iterator[Iterator[bytes]]:
    with http.stream("GET", str(entry["url"])) as response:
        if response.status_code != 200:
            raise CopyError(f"the bucket answered {response.status_code} for {entry['path']}")
        reader = StreamReader(response.iter_bytes(CHUNK))
        key = entry.get("key")
        if not key:
            yield iter(lambda: reader.read(CHUNK), b"")
            return
        header = parse_header(read_exact(reader, HEADER))
        yield plain_chunks(reader, open_chunks(header, base64.b64decode(str(key))))


def bucket_opener(http: httpx.Client) -> Opener:
    return lambda entry: bucket_chunks(http, entry)


def main_opener(client: Any, files_url: str, headers: dict[str, str]) -> Opener:
    @contextmanager
    def opened(entry: dict[str, Any]) -> Iterator[Iterator[bytes]]:
        with client.stream("GET", f"{files_url}/{entry['path']}", headers=headers) as response:
            response.raise_for_status()
            yield response.iter_bytes()

    return opened


def opener_for(listing: dict[str, Any], client: Any, files_url: str, headers: dict[str, str], bucket: Any) -> Opener:
    if listing.get("store") == BUCKET:
        return bucket_opener(bucket)
    return main_opener(client, files_url, headers)
