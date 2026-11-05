import hashlib
import io
import re
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, BinaryIO

from fsspec.spec import AbstractFileSystem

from minibrain.encryption.envelope import Sealer, sync
from minibrain.encryption.sealed import KeySource

if TYPE_CHECKING:
    from minibrain.artifacts import ArtifactStore

PROTOCOL = "mbsealed"
ARTIFACT = "a"
STAGED = "s"
EPOCH = datetime(2000, 1, 1, tzinfo=UTC)
STORES: dict[str, "ArtifactStore"] = {}
LOCK = threading.Lock()


class SealedPathError(FileNotFoundError):
    pass


def token_of(store: "ArtifactStore") -> str:
    token = hashlib.sha256(str(store.root.resolve()).encode(), usedforsecurity=False).hexdigest()[:16]
    with LOCK:
        STORES[token] = store
    return token


def safe_name(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", Path(name).name) or "file"


def artifact_url(store: "ArtifactStore", artifact_id: str, name: str) -> str:
    return f"{PROTOCOL}://{token_of(store)}/{ARTIFACT}/{artifact_id}/{safe_name(name)}"


def staged_url(store: "ArtifactStore", relative: str) -> str:
    return f"{PROTOCOL}://{token_of(store)}/{STAGED}/{relative}"


class SealingFile(io.RawIOBase):
    def __init__(self, path: Path, keys: KeySource | None, context: bytes) -> None:
        super().__init__()
        self.handle: BinaryIO = path.open("wb")
        self.keys = keys
        self.context = context
        self.sealer = Sealer(self.handle) if keys is not None and keys.sealing() else None
        self.written = 0

    def writable(self) -> bool:
        return True

    def tell(self) -> int:
        return self.written

    def write(self, data: Any) -> int:
        block = bytes(data)
        if self.sealer is not None:
            self.sealer.write(block)
        else:
            self.handle.write(block)
        self.written += len(block)
        return len(block)

    def close(self) -> None:
        if self.closed:
            return
        try:
            if self.sealer is not None and self.keys is not None:
                self.sealer.finish(self.keys.wrap(self.sealer.key, self.context))
            sync(self.handle)
        finally:
            self.handle.close()
            super().close()


class SealedFiles(AbstractFileSystem):
    protocol = PROTOCOL

    def resolve(self, path: str) -> tuple["ArtifactStore", str, str]:
        stripped = str(self._strip_protocol(path)).lstrip("/")
        parts = stripped.split("/", 2)
        if len(parts) < 3:
            raise SealedPathError(path)
        with LOCK:
            store = STORES.get(parts[0])
        if store is None or parts[1] not in (ARTIFACT, STAGED):
            raise SealedPathError(path)
        return store, parts[1], parts[2]

    def _open(
        self,
        path: str,
        mode: str = "rb",
        block_size: Any = None,
        autocommit: bool = True,
        cache_options: Any = None,
        **kwargs: Any,
    ) -> Any:
        store, kind, rest = self.resolve(path)
        if "w" in mode:
            if kind != STAGED:
                raise PermissionError("artifacts are written through the store, not DuckDB")
            return store.staged_writer(rest)
        if kind == ARTIFACT:
            return store.open(rest.split("/", 1)[0])
        return store.open_staged(rest)

    def info(self, path: str, **_kwargs: Any) -> dict[str, Any]:
        store, kind, rest = self.resolve(path)
        size = store.plain_size(rest.split("/", 1)[0]) if kind == ARTIFACT else store.staged_size(rest)
        return {"name": str(self._strip_protocol(path)), "size": size, "type": "file"}

    def modified(self, path: str) -> datetime:
        store, kind, rest = self.resolve(path)
        return EPOCH if kind == ARTIFACT else store.staged_modified(rest)

    def ls(self, path: str, detail: bool = True, **kwargs: Any) -> list[Any]:
        found = self.info(path, **kwargs)
        return [found] if detail else [found["name"]]

    def exists(self, path: str, **_kwargs: Any) -> bool:
        try:
            self.info(path)
        except (FileNotFoundError, OSError):
            return False
        return True

    def rm_file(self, path: str) -> None:
        store, kind, rest = self.resolve(path)
        if kind == STAGED:
            store.remove_staged(rest)

    def makedirs(self, path: str, exist_ok: bool = False) -> None:
        return None

    def mkdir(self, path: str, create_parents: bool = True, **_kwargs: Any) -> None:
        return None


FILES = SealedFiles()


def register(connection: Any) -> None:
    connection.register_filesystem(FILES)
