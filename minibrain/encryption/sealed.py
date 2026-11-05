import hashlib
import os
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Protocol, cast

from minibrain.encryption.envelope import (
    CHUNK,
    HEADER,
    EnvelopeError,
    Header,
    Readable,
    SealedReader,
    Sealer,
    Sink,
    Wrapped,
    build_header,
    is_sealed,
    open_chunks,
    parse_header,
    read_exact,
    rewrite_slot,
    sync,
    total_size,
)

NO_KEYS = "this file is encrypted and this process holds no master key"


class KeySource(Protocol):
    def sealing(self) -> bool: ...

    def wrap(self, key: bytes, context: bytes) -> Wrapped: ...

    def unwrap(self, wrapped: Wrapped, context: bytes) -> bytes: ...

    def is_current(self, wrapped: Wrapped) -> bool: ...


@dataclass(frozen=True)
class FileState:
    sealed: bool
    keys: tuple[str, ...] = ()
    current: bool = False


def artifact_context(artifact_id: str) -> bytes:
    return f"minibrain.artifact.{artifact_id}".encode()


def unwrap_any(keys: KeySource, header: Header, context: bytes) -> bytes:
    failures: list[Exception] = []
    for slot in header.slots:
        try:
            return keys.unwrap(slot.wrapped, context)
        except Exception as error:
            failures.append(error)
    raise failures[0]


def open_reader(raw: BinaryIO, keys: KeySource | None, context: bytes) -> BinaryIO:
    head = read_exact(raw, HEADER)
    if not is_sealed(head):
        raw.seek(0)
        return raw
    try:
        if keys is None:
            raise EnvelopeError(NO_KEYS)
        header = parse_header(head)
        reader = SealedReader(raw, open_chunks(header, unwrap_any(keys, header, context)), total_size(raw))
    except BaseException:
        raw.close()
        raise
    return cast(BinaryIO, reader)


def state_of(head: bytes, keys: KeySource | None) -> FileState:
    if not is_sealed(head):
        return FileState(sealed=False)
    header = parse_header(head)
    wrapped = [slot.wrapped for slot in header.slots]
    current = keys is not None and len(wrapped) == 1 and keys.is_current(wrapped[0])
    return FileState(sealed=True, keys=tuple(f"{item.provider}:{item.key}" for item in wrapped), current=current)


def seal_stream(
    source: Readable, sink: Sink, keys: KeySource, context_of: Callable[[str], bytes], chunk: int = CHUNK
) -> tuple[str, int]:
    digest = hashlib.sha256()
    sealer = Sealer(sink, chunk)
    while block := source.read(CHUNK):
        digest.update(block)
        sealer.write(block)
    found = digest.hexdigest()
    sealer.finish(keys.wrap(sealer.key, context_of(found)))
    return found, sealer.size


def plain_digest(path: Path, keys: KeySource | None, context: bytes) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with open_reader(path.open("rb"), keys, context) as stream:
        while block := stream.read(CHUNK):
            digest.update(block)
            size += len(block)
    return digest.hexdigest(), size


def sealed_copy(source: Path, directory: Path, keys: KeySource, context: bytes) -> tuple[Path, str]:
    descriptor, name = tempfile.mkstemp(dir=directory, prefix=".sealing-")
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "w+b") as sink, source.open("rb") as stream:
            found, _ = seal_stream(stream, sink, keys, lambda _digest: context)
            sync(sink)
        return temporary, found
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def verified(temporary: Path, keys: KeySource, context: bytes, expected: str) -> None:
    found, _ = plain_digest(temporary, keys, context)
    if found != expected:
        raise EnvelopeError(f"the encrypted copy reads back as {found}, not {expected}")


def sync_directory(directory: Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def encrypt_in_place(path: Path, keys: KeySource, context: bytes, expected: str | None = None) -> bool:
    with path.open("rb") as stream:
        if is_sealed(read_exact(stream, HEADER)):
            return False
    temporary, found = sealed_copy(path, path.parent, keys, context)
    try:
        if expected is not None and found != expected:
            raise EnvelopeError(f"{path.name} holds content that hashes to {found}, so it was left as it is")
        verified(temporary, keys, context, found)
        if not path.exists():
            return False
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)
    return True


def rewrap_in_place(path: Path, keys: KeySource, context: bytes) -> bool:
    with path.open("r+b") as handle:
        head = read_exact(handle, HEADER)
        if not is_sealed(head):
            return False
        header = parse_header(head)
        if len(header.slots) == 1 and keys.is_current(header.newest.wrapped):
            return False
        key = unwrap_any(keys, header, context)
        rewrite_slot(handle, header, keys.wrap(key, context))
    return True


def rewrap_head(head: bytes, keys: KeySource, context: bytes) -> bytes | None:
    header = parse_header(head)
    if len(header.slots) == 1 and keys.is_current(header.newest.wrapped):
        return None
    key = unwrap_any(keys, header, context)
    return build_header(header.prefix, header.chunk, keys.wrap(key, context), header.newest.seq + 1)
