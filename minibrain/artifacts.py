import hashlib
import io
import os
import shutil
import tarfile
import tempfile
from collections.abc import Iterator
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import BinaryIO, Protocol

CHUNK = 1 << 20


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

    def download(self, artifact_id: str, target: Path) -> None: ...

    def open(self, artifact_id: str) -> BinaryIO: ...

    def delete(self, artifact_id: str) -> None: ...


class ArtifactStore:
    def __init__(self, root: Path, cache: Path) -> None:
        self.root = root
        self.cache = cache
        self.remote: RemoteBlobs | None = None
        self.writes_remote = False

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

    def put_stream(self, stream: Readable, expected: str | None = None) -> Stored:
        self.root.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256()
        size = 0
        with tempfile.NamedTemporaryFile(dir=self.root, delete=False) as temporary:
            while chunk := stream.read(CHUNK):
                digest.update(chunk)
                temporary.write(chunk)
                size += len(chunk)
        artifact_id = digest.hexdigest()
        if expected is not None and expected != artifact_id:
            Path(temporary.name).unlink(missing_ok=True)
            raise ArtifactError(f"content hashes to {artifact_id}, not {expected}")
        if self.writes_remote and self.remote is not None:
            try:
                if not self.remote.has(artifact_id):
                    self.remote.upload(Path(temporary.name), artifact_id)
            finally:
                Path(temporary.name).unlink(missing_ok=True)
            return Stored(id=artifact_id, size=size)
        target = self.path(artifact_id)
        if target.exists():
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

    def open(self, artifact_id: str) -> BinaryIO:
        if self.local(artifact_id):
            return self.path(artifact_id).open("rb")
        if self.remote is not None and self.remote.has(artifact_id):
            return self.remote.open(artifact_id)
        raise ArtifactError(f"artifact {artifact_id} not found")

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
        if packing == Packing.FILE:
            if source.parent == staging:
                os.replace(source, staging / name)
            else:
                shutil.copyfile(source, staging / name)
        else:
            with tarfile.open(source) as archive:
                archive.extractall(staging / "tree", filter="data")
            if source.parent == staging:
                source.unlink()
        (staging / ".complete").touch()
        try:
            os.replace(staging, target)
        except OSError:
            shutil.rmtree(staging, ignore_errors=True)
        return result
