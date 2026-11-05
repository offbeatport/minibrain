import os
from collections.abc import Iterator
from contextlib import AbstractContextManager, contextmanager
from pathlib import Path
from typing import Any, Protocol

import fsspec
import httpx

from minibrain.connections.s3 import FILESYSTEMS, env_connection
from minibrain.ml.context import FinalError
from minibrain.models import hub
from minibrain.models.files import CHUNK, file_chunks
from minibrain.models.rules import needed

FOLDER = "folder"
S3 = "s3"
HUB = "hub"


class HubAccessError(Exception):
    def __init__(self, path: str, status: int) -> None:
        super().__init__(path)
        self.path = path
        self.status = status


class HubGoneError(Exception):
    def __init__(self, path: str) -> None:
        super().__init__(path)
        self.path = path


class FileSource(Protocol):
    def describe(self) -> str: ...

    def opened(self, path: str, offset: int) -> AbstractContextManager[tuple[int, Iterator[bytes]]]: ...


def s3_endpoint() -> str:
    return os.environ.get("AWS_ENDPOINT_URL_S3") or os.environ.get("AWS_ENDPOINT_URL") or "https://s3.amazonaws.com"


def s3_base() -> str | None:
    found = os.environ.get("MINIBRAIN_MODELS_S3_URL", "").strip().rstrip("/")
    return found or None


def location_url(kind: str, location: str) -> str:
    location = location.strip()
    if kind == FOLDER:
        return str(Path(location).expanduser())
    if location.startswith("s3://"):
        return location.rstrip("/")
    base = s3_base()
    if base is None:
        raise FinalError("Give a full s3:// URL, or set MINIBRAIN_MODELS_S3_URL to a bucket prefix")
    return f"{base}/{location.strip('/')}"


def connection_filesystem(url: str) -> Any | None:
    found = env_connection() if url.startswith("s3://") else None
    return FILESYSTEMS["s3"](*found) if found is not None else None


class StorageSource:
    def __init__(self, url: str, filesystem: Any | None = None) -> None:
        self.url = url
        chosen = filesystem if filesystem is not None else connection_filesystem(url)
        if chosen is not None:
            self.fs, self.root = chosen, url.removeprefix("s3://").rstrip("/")
            return
        try:
            self.fs, self.root = fsspec.core.url_to_fs(url)
        except ImportError as error:
            raise FinalError(f"No driver for {url}: {error}") from error

    def describe(self) -> str:
        return self.url

    def names(self) -> set[str]:
        try:
            listing = self.fs.ls(self.root, detail=True)
        except (FileNotFoundError, PermissionError):
            return set()
        return {str(item["name"]).rstrip("/").rsplit("/", 1)[-1] for item in listing if item.get("type") == "file"}

    def files(self) -> list[dict[str, Any]]:
        try:
            listing = self.fs.ls(self.root, detail=True)
        except FileNotFoundError as error:
            raise FinalError(f"{self.url} does not exist or is not readable") from error
        except PermissionError as error:
            raise FinalError(f"Access denied to {self.url}: check the credentials") from error
        found = []
        for item in listing:
            name = str(item["name"]).rstrip("/").rsplit("/", 1)[-1]
            if item.get("type") == "file" and needed(name):
                found.append({"path": name, "size": int(item.get("size") or 0), "sha256": None})
        return sorted(found, key=lambda item: item["path"])

    def read_text(self, path: str) -> str:
        with self.fs.open(f"{self.root}/{path}", "rb") as stream:
            return stream.read().decode()

    def chunks(self, path: str) -> Iterator[bytes]:
        with self.fs.open(f"{self.root}/{path}", "rb") as stream:
            while chunk := stream.read(CHUNK):
                yield chunk

    def size(self, path: str) -> int | None:
        try:
            return int(self.fs.info(f"{self.root}/{path}").get("size") or 0)
        except FileNotFoundError:
            return None

    @contextmanager
    def opened(self, path: str, offset: int) -> Iterator[tuple[int, Iterator[bytes]]]:
        with self.fs.open(f"{self.root}/{path}", "rb") as stream:
            if offset:
                stream.seek(offset)

            def read() -> Iterator[bytes]:
                while chunk := stream.read(CHUNK):
                    yield chunk

            yield offset, read()


class HubSource:
    def __init__(self, repo: str, revision: str, manifest: list[dict[str, Any]], client: httpx.Client) -> None:
        self.repo = repo
        self.revision = revision
        self.manifest = manifest
        self.client = client

    def describe(self) -> str:
        return f"{hub.endpoint()}/{self.repo}@{self.revision[:12]}"

    def files(self) -> list[dict[str, Any]]:
        return self.manifest

    def cached(self, path: str) -> Path | None:
        from huggingface_hub import try_to_load_from_cache

        found = try_to_load_from_cache(self.repo, path, revision=self.revision)
        return Path(found) if isinstance(found, str) and Path(found).is_file() else None

    def chunks(self, path: str) -> Iterator[bytes]:
        with self.opened(path, 0) as (_start, chunks):
            yield from chunks

    @contextmanager
    def opened(self, path: str, offset: int) -> Iterator[tuple[int, Iterator[bytes]]]:
        local = self.cached(path)
        if local is not None:
            yield 0, file_chunks(local)
            return
        url = hub.file_url(self.repo, self.revision, path)
        headers = hub.headers() | ({"Range": f"bytes={offset}-"} if offset else {})
        with self.client.stream("GET", url, headers=headers) as response:
            if response.status_code in (401, 403):
                raise HubAccessError(path, response.status_code)
            if response.status_code == 404:
                raise HubGoneError(path)
            response.raise_for_status()
            yield (offset if response.status_code == 206 else 0), response.iter_bytes(CHUNK)
