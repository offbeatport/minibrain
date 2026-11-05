import hashlib
import io
import os
import shutil
import tarfile
import tempfile
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from typing import Any, BinaryIO, Protocol, cast

from minibrain.encryption import duck
from minibrain.encryption.envelope import HEADER, Sink, is_sealed, read_exact
from minibrain.encryption.sealed import KeySource, artifact_context, open_reader, seal_stream, sealed_copy

CHUNK = 1 << 20
STAGED_NAME = "staging.duckdb"
INCOMING = ".incoming"


class Packing(StrEnum):
    FILE = "file"
    TAR = "tar"


class ArtifactError(Exception):
    pass


class Readable(Protocol):
    def read(self, size: int = -1, /) -> bytes: ...


@dataclass(frozen=True)
class Stored:
    id: str
    size: int


def is_artifact_id(value: str) -> bool:
    return len(value) == 64 and all(char in "0123456789abcdef" for char in value)


def normalized(info: tarfile.TarInfo) -> tarfile.TarInfo:
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    info.mtime = 0
    info.mode = 0o755 if info.isdir() else 0o644
    return info


def tar_bytes(directory: Path) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w", format=tarfile.PAX_FORMAT) as archive:
        for path in sorted(directory.rglob("*")):
            archive.add(path, arcname=str(path.relative_to(directory)), recursive=False, filter=normalized)
    return buffer.getvalue()


class RemoteBlobs(Protocol):
    def describe(self) -> str: ...

    def has(self, artifact_id: str) -> bool: ...

    def upload(self, source: Path, artifact_id: str) -> None: ...

    def replace(self, source: Path, artifact_id: str) -> None: ...

    def download(self, artifact_id: str, target: Path) -> None: ...

    def open(self, artifact_id: str) -> BinaryIO: ...

    def delete(self, artifact_id: str) -> None: ...

    def ids(self) -> Iterator[str]: ...

    def head(self, artifact_id: str) -> bytes: ...

    def rewrite_head(self, artifact_id: str, head: bytes) -> None: ...

    def sign(self, artifact_id: str, seconds: int) -> str: ...


class StreamReader:
    def __init__(self, chunks: Any) -> None:
        self.chunks = iter(chunks)
        self.buffer = b""

    def read(self, size: int = -1) -> bytes:
        while size < 0 or len(self.buffer) < size:
            chunk = next(self.chunks, None)
            if chunk is None:
                break
            self.buffer += chunk
        if size < 0:
            data, self.buffer = self.buffer, b""
        else:
            data, self.buffer = self.buffer[:size], self.buffer[size:]
        return data


def staged_context(relative: str) -> bytes:
    return f"minibrain.staging.{relative.split('/', 1)[0]}".encode()


def plain_copy(stream: Readable, sink: Sink) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    while chunk := stream.read(CHUNK):
        digest.update(chunk)
        sink.write(chunk)
        size += len(chunk)
    return digest.hexdigest(), size


def sealed_file(path: Path) -> bool:
    with path.open("rb") as stream:
        return is_sealed(read_exact(stream, HEADER))


class ArtifactStore:
    def __init__(self, root: Path, cache: Path, keys: KeySource | None = None, staging: Path | None = None) -> None:
        self.root = root
        self.cache = cache
        self.keys = keys
        self.staging = staging or root.parent / "staging"
        self.remote: RemoteBlobs | None = None
        self.writes_remote = False
        self.sizes: dict[str, int] = {}

    def sealing(self) -> bool:
        return self.keys is not None and self.keys.sealing()

    def use(self, remote: RemoteBlobs | None, writes: bool) -> None:
        self.remote = remote
        self.writes_remote = remote is not None and writes

    def path(self, artifact_id: str) -> Path:
        if not is_artifact_id(artifact_id):
            raise ArtifactError(f"not an artifact id: {artifact_id}")
        return self.root / artifact_id[:2] / artifact_id

    def local(self, artifact_id: str) -> bool:
        return self.path(artifact_id).is_file()

    def has(self, artifact_id: str) -> bool:
        return self.local(artifact_id) or (self.remote is not None and self.remote.has(artifact_id))

    def incoming(self) -> Path:
        folder = self.root / INCOMING
        folder.mkdir(parents=True, exist_ok=True)
        return folder

    def put_stream(self, stream: Readable, expected: str | None = None, replace: bool = False) -> Stored:
        with tempfile.NamedTemporaryFile(dir=self.incoming(), delete=False) as temporary:
            try:
                if self.sealing() and self.keys is not None:
                    artifact_id, size = seal_stream(stream, temporary, self.keys, artifact_context)
                else:
                    artifact_id, size = plain_copy(stream, temporary)
            except BaseException:
                Path(temporary.name).unlink(missing_ok=True)
                raise
        if expected is not None and expected != artifact_id:
            Path(temporary.name).unlink(missing_ok=True)
            raise ArtifactError(f"content hashes to {artifact_id}, not {expected}")
        if self.writes_remote and self.remote is not None:
            try:
                if replace:
                    self.remote.replace(Path(temporary.name), artifact_id)
                elif not self.remote.has(artifact_id):
                    self.remote.upload(Path(temporary.name), artifact_id)
            finally:
                Path(temporary.name).unlink(missing_ok=True)
            return Stored(id=artifact_id, size=size)
        target = self.path(artifact_id)
        if target.exists() and not replace:
            Path(temporary.name).unlink(missing_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            os.replace(temporary.name, target)
        return Stored(id=artifact_id, size=size)

    def put_file(self, source: Path) -> Stored:
        with source.open("rb") as stream:
            return self.put_stream(stream)

    def put_dir(self, directory: Path) -> Stored:
        return self.put_stream(io.BytesIO(tar_bytes(directory)))

    def raw(self, artifact_id: str) -> BinaryIO:
        if self.local(artifact_id):
            return self.path(artifact_id).open("rb")
        if self.remote is not None and self.remote.has(artifact_id):
            return self.remote.open(artifact_id)
        raise ArtifactError(f"artifact {artifact_id} not found")

    def open(self, artifact_id: str) -> BinaryIO:
        return open_reader(self.raw(artifact_id), self.keys, artifact_context(artifact_id))

    def plain_size(self, artifact_id: str) -> int:
        if artifact_id not in self.sizes:
            with self.open(artifact_id) as stream:
                self.sizes[artifact_id] = stream.seek(0, io.SEEK_END)
        return self.sizes[artifact_id]

    def url(self, artifact_id: str, name: str) -> str:
        if not is_artifact_id(artifact_id):
            raise ArtifactError(f"not an artifact id: {artifact_id}")
        return duck.artifact_url(self, artifact_id, name)

    def staged_path(self, relative: str) -> Path:
        target = (self.staging / relative).resolve()
        if not target.is_relative_to(self.staging.resolve()):
            raise ArtifactError(f"{relative} is outside the staging folder")
        return target

    def staged_writer(self, relative: str) -> BinaryIO:
        target = self.staged_path(relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        return cast(BinaryIO, duck.SealingFile(target, self.keys, staged_context(relative)))

    def open_staged(self, relative: str) -> BinaryIO:
        return open_reader(self.staged_path(relative).open("rb"), self.keys, staged_context(relative))

    def staged_size(self, relative: str) -> int:
        with self.open_staged(relative) as stream:
            return stream.seek(0, io.SEEK_END)

    def staged_modified(self, relative: str) -> datetime:
        return datetime.fromtimestamp(self.staged_path(relative).stat().st_mtime, tz=UTC)

    def remove_staged(self, relative: str) -> None:
        self.staged_path(relative).unlink(missing_ok=True)

    def staged(self, key: str, build: Callable[[Path], None]) -> str:
        relative = f"{key}/{STAGED_NAME}"
        final = self.staged_path(relative)
        if not final.exists():
            final.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            building = Path(tempfile.mkdtemp(dir=final.parent, prefix=".building-"))
            try:
                plain = building / STAGED_NAME
                build(plain)
                if self.sealing() and self.keys is not None:
                    sealed, _ = sealed_copy(plain, building, self.keys, staged_context(relative))
                    os.replace(sealed, final)
                else:
                    os.replace(plain, final)
            finally:
                shutil.rmtree(building, ignore_errors=True)
        return duck.staged_url(self, relative)

    def chunks(self, artifact_id: str) -> Iterator[bytes]:
        with self.open(artifact_id) as stream:
            while chunk := stream.read(CHUNK):
                yield chunk

    def delete(self, artifact_id: str) -> None:
        self.path(artifact_id).unlink(missing_ok=True)
        if self.remote is not None:
            self.remote.delete(artifact_id)
        shutil.rmtree(self.cache / artifact_id, ignore_errors=True)

    def fetch(self, artifact_id: str, target: Path) -> Path:
        if self.local(artifact_id):
            return self.path(artifact_id)
        if self.remote is None or not self.remote.has(artifact_id):
            raise ArtifactError(f"artifact {artifact_id} not found")
        self.remote.download(artifact_id, target)
        return target

    def materialize(self, artifact_id: str, packing: str, name: str) -> Path:
        target = self.cache / artifact_id
        done = target / ".complete"
        result = target / name if packing == Packing.FILE else target / "tree"
        if done.exists():
            return result
        self.cache.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(dir=self.cache))
        source = self.fetch(artifact_id, staging / ".download")
        sealed = sealed_file(source)
        if packing == Packing.FILE and not sealed:
            if source.parent == staging:
                os.replace(source, staging / name)
            else:
                shutil.copyfile(source, staging / name)
        elif packing == Packing.FILE:
            with (
                open_reader(source.open("rb"), self.keys, artifact_context(artifact_id)) as stream,
                (staging / name).open("wb") as target_file,
            ):
                shutil.copyfileobj(stream, target_file, CHUNK)
        else:
            with (
                open_reader(source.open("rb"), self.keys, artifact_context(artifact_id)) as stream,
                tarfile.open(fileobj=stream) as archive,
            ):
                archive.extractall(staging / "tree", filter="data")
        if source.parent == staging:
            source.unlink(missing_ok=True)
        (staging / ".complete").touch()
        try:
            os.replace(staging, target)
        except OSError:
            shutil.rmtree(staging, ignore_errors=True)
        return result
