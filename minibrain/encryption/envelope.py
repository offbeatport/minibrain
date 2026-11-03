import base64
import binascii
import hashlib
import io
import json
import os
import struct
import threading
from collections import OrderedDict
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any, BinaryIO, Protocol

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

MAGIC = b"\x89MBE\r\n\x1a\n"
VERSION = 1
SUITE = 1
CHUNK = 1 << 20
MAX_CHUNK = 64 << 20
TAG = 16
PREFIX = 7
FIXED = 64
SLOT = 2016
SLOTS = (FIXED, FIXED + SLOT)
HEADER = FIXED + 2 * SLOT
DIGEST = 32
SLOT_HEAD = 6
KEY_BYTES = 32
MAX_CHUNKS = 1 << 32
CACHED_CHUNKS = 8


class EnvelopeError(Exception):
    pass


class Readable(Protocol):
    def read(self, size: int = -1, /) -> bytes: ...


class Sink(Protocol):
    def write(self, data: bytes, /) -> int: ...

    def tell(self) -> int: ...

    def seek(self, offset: int, whence: int = 0, /) -> int: ...


@dataclass(frozen=True)
class Wrapped:
    provider: str
    key: str
    blob: bytes

    def as_dict(self) -> dict[str, str]:
        return {"p": self.provider, "k": self.key, "w": base64.b64encode(self.blob).decode()}

    @staticmethod
    def from_dict(value: Any) -> "Wrapped":
        if not isinstance(value, dict):
            raise EnvelopeError("a wrapped data key is a JSON object")
        try:
            return Wrapped(str(value["p"]), str(value["k"]), base64.b64decode(str(value["w"]), validate=True))
        except (KeyError, binascii.Error, ValueError) as error:
            raise EnvelopeError("the wrapped data key is damaged") from error


@dataclass(frozen=True)
class Slot:
    offset: int
    seq: int
    wrapped: Wrapped


@dataclass(frozen=True)
class Header:
    fixed: bytes
    chunk: int
    prefix: bytes
    slots: tuple[Slot, ...]

    @property
    def newest(self) -> Slot:
        return self.slots[0]


def new_key() -> bytes:
    return AESGCM.generate_key(bit_length=KEY_BYTES * 8)


def fixed_header(prefix: bytes, chunk: int) -> bytes:
    head = MAGIC + struct.pack(">BBHI", VERSION, SUITE, 0, chunk) + prefix
    return head + bytes(FIXED - len(head))


def encode_slot(seq: int, wrapped: Wrapped) -> bytes:
    payload = json.dumps(wrapped.as_dict(), separators=(",", ":"), sort_keys=True).encode()
    if len(payload) > SLOT - SLOT_HEAD - DIGEST:
        raise EnvelopeError(f"the wrapped data key from {wrapped.provider} is too large for the file header")
    body = struct.pack(">IH", seq, len(payload)) + payload
    body += bytes(SLOT - DIGEST - len(body))
    return body + hashlib.sha256(body).digest()


def decode_slot(offset: int, raw: bytes) -> Slot | None:
    body, digest = raw[:-DIGEST], raw[-DIGEST:]
    seq, length = struct.unpack(">IH", body[:SLOT_HEAD])
    if seq == 0 or length > len(body) - SLOT_HEAD or hashlib.sha256(body).digest() != digest:
        return None
    try:
        wrapped = Wrapped.from_dict(json.loads(body[SLOT_HEAD : SLOT_HEAD + length]))
    except (EnvelopeError, ValueError):
        return None
    return Slot(offset=offset, seq=seq, wrapped=wrapped)


def build_header(prefix: bytes, chunk: int, wrapped: Wrapped, seq: int = 1) -> bytes:
    return fixed_header(prefix, chunk) + encode_slot(seq, wrapped) + bytes(SLOT)


def is_sealed(head: bytes) -> bool:
    return head[: len(MAGIC)] == MAGIC


def parse_header(raw: bytes) -> Header:
    if len(raw) < HEADER or not is_sealed(raw):
        raise EnvelopeError("not an encrypted minibrain file")
    version, suite, reserved, chunk = struct.unpack(">BBHI", raw[len(MAGIC) : len(MAGIC) + 8])
    if version != VERSION or suite != SUITE:
        raise EnvelopeError(f"encryption format {version}.{suite} is newer than this minibrain")
    start = len(MAGIC) + 8
    if reserved or not 0 < chunk <= MAX_CHUNK or any(raw[start + PREFIX : FIXED]):
        raise EnvelopeError("the encrypted file's header is damaged")
    slots = [found for offset in SLOTS if (found := decode_slot(offset, raw[offset : offset + SLOT])) is not None]
    if not slots:
        raise EnvelopeError("the encrypted file's key slots are damaged")
    ordered = tuple(sorted(slots, key=lambda slot: slot.seq, reverse=True))
    return Header(fixed=raw[:FIXED], chunk=chunk, prefix=raw[start : start + PREFIX], slots=ordered)


def nonce(prefix: bytes, index: int, final: bool) -> bytes:
    if index >= MAX_CHUNKS:
        raise EnvelopeError("the file has more chunks than the format allows")
    return prefix + struct.pack(">IB", index, 1 if final else 0)


def layout(total: int, chunk: int) -> tuple[int, int]:
    body = total - HEADER
    full = chunk + TAG
    count = max(1, -(-body // full))
    if body < TAG or body - (count - 1) * full < TAG:
        raise EnvelopeError("the encrypted file is truncated")
    return count, body - count * TAG


def read_exact(stream: Readable, size: int) -> bytes:
    parts: list[bytes] = []
    remaining = size
    while remaining > 0:
        part = stream.read(remaining)
        if not part:
            break
        parts.append(part)
        remaining -= len(part)
    return b"".join(parts)


class Chunks:
    def __init__(self, header: Header, key: bytes) -> None:
        self.header = header
        self.cipher = AESGCM(key)

    def seal(self, index: int, block: bytes, final: bool) -> bytes:
        return self.cipher.encrypt(nonce(self.header.prefix, index, final), block, self.header.fixed)

    def open(self, index: int, data: bytes, final: bool) -> bytes:
        try:
            return self.cipher.decrypt(nonce(self.header.prefix, index, final), data, self.header.fixed)
        except InvalidTag as error:
            message = f"chunk {index} failed authentication: the file was changed, reordered or cut"
            raise EnvelopeError(message) from error


class Sealer:
    def __init__(self, sink: Sink, chunk: int = CHUNK) -> None:
        if not 0 < chunk <= MAX_CHUNK:
            raise EnvelopeError("chunk size out of range")
        self.sink = sink
        self.start = sink.tell()
        self.key = new_key()
        prefix = os.urandom(PREFIX)
        self.chunks = Chunks(Header(fixed=fixed_header(prefix, chunk), chunk=chunk, prefix=prefix, slots=()), self.key)
        self.pending = bytearray()
        self.index = 0
        self.size = 0
        sink.write(self.chunks.header.fixed + bytes(2 * SLOT))

    def write(self, data: bytes) -> int:
        self.pending += data
        self.size += len(data)
        chunk = self.chunks.header.chunk
        while len(self.pending) > chunk:
            self.emit(bytes(self.pending[:chunk]), final=False)
            del self.pending[:chunk]
        return len(data)

    def emit(self, block: bytes, final: bool) -> None:
        self.sink.write(self.chunks.seal(self.index, block, final))
        self.index += 1

    def finish(self, wrapped: Wrapped) -> None:
        self.emit(bytes(self.pending), final=True)
        self.pending.clear()
        end = self.sink.tell()
        self.sink.seek(self.start + SLOTS[0])
        self.sink.write(encode_slot(1, wrapped))
        self.sink.seek(end)


def open_chunks(header: Header, key: bytes) -> Chunks:
    if len(key) != KEY_BYTES:
        raise EnvelopeError("the data key is not 256 bits")
    return Chunks(header, key)


def plain_chunks(raw: Readable, chunks: Chunks) -> Iterator[bytes]:
    full = chunks.header.chunk + TAG
    index = 0
    current = read_exact(raw, full)
    while True:
        if len(current) < TAG:
            raise EnvelopeError("the encrypted file is truncated")
        following = read_exact(raw, full) if len(current) == full else b""
        if not following:
            yield chunks.open(index, current, final=True)
            return
        yield chunks.open(index, current, final=False)
        current = following
        index += 1


def total_size(raw: BinaryIO) -> int:
    raw.seek(0, io.SEEK_END)
    size = raw.tell()
    raw.seek(0)
    return size


class SealedReader(io.RawIOBase):
    def __init__(self, raw: BinaryIO, chunks: Chunks, total: int) -> None:
        super().__init__()
        self.raw = raw
        self.chunks = chunks
        self.count, self.size = layout(total, chunks.header.chunk)
        self.lock = threading.Lock()
        self.cache: OrderedDict[int, bytes] = OrderedDict()
        self.position = threading.local()

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return getattr(self.position, "at", 0)

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        base = {io.SEEK_SET: 0, io.SEEK_CUR: self.tell(), io.SEEK_END: self.size}[whence]
        if base + offset < 0:
            raise ValueError("negative seek position")
        self.position.at = base + offset
        return self.position.at

    def block(self, index: int) -> bytes:
        with self.lock:
            found = self.cache.get(index)
            if found is not None:
                self.cache.move_to_end(index)
                return found
            full = self.chunks.header.chunk + TAG
            final = index == self.count - 1
            length = self.last_length() if final else full
            self.raw.seek(HEADER + index * full)
            data = read_exact(self.raw, length)
            if len(data) != length:
                raise EnvelopeError("the encrypted file is truncated")
            plain = self.chunks.open(index, data, final)
            self.cache[index] = plain
            if len(self.cache) > CACHED_CHUNKS:
                self.cache.popitem(last=False)
            return plain

    def last_length(self) -> int:
        full = self.chunks.header.chunk + TAG
        return self.size + self.count * TAG - (self.count - 1) * full

    def read(self, size: int | None = -1, /) -> bytes:
        start = self.tell()
        end = self.size if size is None or size < 0 else min(self.size, start + size)
        chunk = self.chunks.header.chunk
        parts: list[bytes] = []
        at = start
        while at < end:
            index = at // chunk
            block = self.block(index)
            piece = block[at - index * chunk : end - index * chunk]
            if not piece:
                break
            parts.append(piece)
            at += len(piece)
        self.position.at = at
        return b"".join(parts)

    def readall(self) -> bytes:
        return self.read(-1)

    def readinto(self, buffer: Any) -> int:
        data = self.read(len(buffer))
        buffer[: len(data)] = data
        return len(data)

    def close(self) -> None:
        if not self.closed:
            self.raw.close()
        super().close()


def rewrite_slot(handle: BinaryIO, header: Header, wrapped: Wrapped) -> None:
    newest = header.newest
    target = SLOTS[1] if newest.offset == SLOTS[0] else SLOTS[0]
    handle.seek(target)
    handle.write(encode_slot(newest.seq + 1, wrapped))
    sync(handle)
    handle.seek(newest.offset)
    handle.write(bytes(SLOT))
    sync(handle)


def sync(handle: BinaryIO) -> None:
    handle.flush()
    os.fsync(handle.fileno())


def seal_bytes(key: bytes, plaintext: bytes, context: bytes) -> bytes:
    sealed_nonce = os.urandom(12)
    return sealed_nonce + AESGCM(key).encrypt(sealed_nonce, plaintext, context)


def open_bytes(key: bytes, sealed: bytes, context: bytes) -> bytes:
    try:
        return AESGCM(key).decrypt(sealed[:12], sealed[12:], context)
    except (InvalidTag, ValueError) as error:
        raise EnvelopeError("the sealed value failed authentication") from error
