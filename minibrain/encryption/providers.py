import base64
import binascii
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from cryptography.hazmat.primitives import hashes, hmac

from minibrain.encryption.envelope import KEY_BYTES, EnvelopeError, Wrapped, new_key, open_bytes, seal_bytes

LOCAL = "local"
KEY_ID_LABEL = b"minibrain.master-key.id"
WRAP_LABEL = b"minibrain.wrap:"


class KeyUnavailableError(Exception):
    pass


class KeyProvider(Protocol):
    kind: str

    def current(self) -> str: ...

    def wrap(self, key: bytes, context: bytes) -> Wrapped: ...

    def unwrap(self, wrapped: Wrapped, context: bytes) -> bytes: ...

    def rotate(self) -> str: ...

    def retire(self, keep: set[str]) -> list[str]: ...

    def describe(self) -> str: ...


@dataclass(frozen=True)
class KeyFile:
    path: Path
    mounted: bool


def key_id(key: bytes) -> str:
    signer = hmac.HMAC(key, hashes.SHA256())
    signer.update(KEY_ID_LABEL)
    return signer.finalize()[:8].hex()


def wrap_context(context: bytes) -> bytes:
    return WRAP_LABEL + context


def parse_ring(path: Path, text: str) -> list[bytes]:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        raise KeyUnavailableError(f"{path} holds no master key")
    ring: list[bytes] = []
    for line in lines:
        try:
            key = base64.b64decode(line, validate=True)
        except (binascii.Error, ValueError) as error:
            raise KeyUnavailableError(f"{path} does not hold base64 master keys, one per line") from error
        if len(key) != KEY_BYTES:
            raise KeyUnavailableError(
                f"{path} must hold 256-bit keys, one per line, such as the output of openssl rand -base64 32"
            )
        ring.append(key)
    return ring


def ring_text(ring: list[bytes]) -> str:
    return "".join(base64.b64encode(key).decode() + "\n" for key in ring)


def write_private(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.parent.chmod(0o700)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        stream.write(text)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def create_exclusive(path: Path, text: str) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.parent.chmod(0o700)
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return False
    with os.fdopen(descriptor, "w") as stream:
        stream.write(text)
        stream.flush()
        os.fsync(stream.fileno())
    return True


class LocalKeys:
    kind = LOCAL

    def __init__(self, source: KeyFile, may_create: bool = True) -> None:
        self.source = source
        self.lock = threading.Lock()
        self.stamp: tuple[int, int] | None = None
        self.ring: list[bytes] = []
        self.prepare(may_create)
        self.refresh()

    def prepare(self, may_create: bool) -> None:
        path = self.source.path
        if path.is_file():
            return
        if self.source.mounted:
            raise KeyUnavailableError(f"the master key file {path} does not exist")
        if may_create:
            create_exclusive(path, ring_text([new_key()]))
        else:
            raise KeyUnavailableError(
                f"this install already encrypts with a local master key that is not on this server: copy "
                f"{path} from the server that made it, or mount it and set MINIBRAIN_MASTER_KEY_FILE"
            )

    def refresh(self) -> list[bytes]:
        path = self.source.path
        with self.lock:
            try:
                found = path.stat()
            except FileNotFoundError as error:
                raise KeyUnavailableError(f"the master key file {path} does not exist") from error
            stamp = (found.st_mtime_ns, found.st_size)
            if stamp != self.stamp:
                self.ring = parse_ring(path, path.read_text())
                self.stamp = stamp
            return self.ring

    def by_id(self) -> dict[str, bytes]:
        return {key_id(key): key for key in self.refresh()}

    def current(self) -> str:
        return key_id(self.refresh()[-1])

    def known(self) -> list[str]:
        return [key_id(key) for key in self.refresh()]

    def wrap(self, key: bytes, context: bytes) -> Wrapped:
        master = self.refresh()[-1]
        return Wrapped(LOCAL, key_id(master), seal_bytes(master, key, wrap_context(context)))

    def unwrap(self, wrapped: Wrapped, context: bytes) -> bytes:
        master = self.by_id().get(wrapped.key)
        if master is None:
            raise KeyUnavailableError(f"local master key {wrapped.key} is not in {self.source.path}")
        try:
            return open_bytes(master, wrapped.blob, wrap_context(context))
        except EnvelopeError as error:
            raise EnvelopeError(f"the data key does not open with local master key {wrapped.key}") from error

    def rotate(self) -> str:
        if self.source.mounted:
            raise KeyUnavailableError(
                f"{self.source.path} is mounted from outside minibrain: add a new key as its last line "
                "(openssl rand -base64 32) on every main, restart them, then rotate again"
            )
        with self.lock:
            ring = [*parse_ring(self.source.path, self.source.path.read_text()), new_key()]
            write_private(self.source.path, ring_text(ring))
        return key_id(self.refresh()[-1])

    def retire(self, keep: set[str]) -> list[str]:
        ring = self.refresh()
        current = key_id(ring[-1])
        dropped = [key_id(key) for key in ring if key_id(key) not in keep and key_id(key) != current]
        if not dropped or self.source.mounted:
            return []
        with self.lock:
            fresh = parse_ring(self.source.path, self.source.path.read_text())
            write_private(self.source.path, ring_text([key for key in fresh if key_id(key) not in dropped]))
        self.refresh()
        return dropped

    def describe(self) -> str:
        return str(self.source.path)
