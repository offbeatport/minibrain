import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any, Protocol

import fsspec
import httpx

from minibrain.ml.context import FinalError
from minibrain.models import hub
from minibrain.models.files import CHUNK, file_chunks

FOLDER = "folder"
S3 = "s3"
HUB = "hub"


class ModelSource(Protocol):
    def describe(self) -> str: ...

    def files(self) -> list[dict[str, Any]]: ...

    def chunks(self, path: str) -> Iterator[bytes]: ...


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


def configured() -> list[dict[str, Any]]:
    return [
        {"type": HUB, "label": "Hugging Face endpoint", "location": hub.endpoint(), "available": not hub.offline()},
        {"type": S3, "label": "S3-compatible bucket", "location": s3_base(), "available": True},
        {"type": FOLDER, "label": "Folder on the server", "location": None, "available": True},
    ]


class StorageSource:
    def __init__(self, url: str) -> None:
        self.url = url
        try:
            self.fs, self.root = fsspec.core.url_to_fs(url)
        except ImportError as error:
            raise FinalError(f"No driver for {url}: {error}") from error

    def describe(self) -> str:
        return self.url

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
            if item.get("type") == "file" and hub.needed(name):
                found.append({"path": name, "size": int(item.get("size") or 0), "sha256": None})
        return sorted(found, key=lambda item: item["path"])

    def read_text(self, path: str) -> str:
        with self.fs.open(f"{self.root}/{path}", "rb") as stream:
            return stream.read().decode()

    def chunks(self, path: str) -> Iterator[bytes]:
        with self.fs.open(f"{self.root}/{path}", "rb") as stream:
            while chunk := stream.read(CHUNK):
                yield chunk


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
        local = self.cached(path)
        if local is not None:
            yield from file_chunks(local)
            return
        url = hub.file_url(self.repo, self.revision, path)
        with self.client.stream("GET", url, headers=hub.headers()) as response:
            if response.status_code in (401, 403):
                raise PermissionError(path)
            if response.status_code == 404:
                raise FinalError(f"{path} is not published at revision {self.revision[:12]}")
            response.raise_for_status()
            yield from response.iter_bytes(CHUNK)
