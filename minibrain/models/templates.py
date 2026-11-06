import json
import struct
from collections.abc import Callable
from typing import BinaryIO

GGUF_MAGIC = b"GGUF"
TEMPLATE_KEY = "tokenizer.chat_template"
MAX_KEYS = 100_000
FIXED = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}
STRING = 8
ARRAY = 9
TEMPLATE_FILES = ("chat_template.jinja", "chat_template.json", "tokenizer_config.json")

Opener = Callable[[str], bytes | None]


def from_config(raw: bytes) -> str | None:
    try:
        found = json.loads(raw)
    except ValueError:
        return None
    template = found.get("chat_template") if isinstance(found, dict) else None
    if isinstance(template, list):
        named = {item.get("name"): item.get("template") for item in template if isinstance(item, dict)}
        template = named.get("default") or next(iter(named.values()), None)
    return template if isinstance(template, str) else None


def template_in_files(read: Opener) -> str | None:
    for name in TEMPLATE_FILES:
        raw = read(name)
        if raw is None:
            continue
        if name.endswith(".jinja"):
            return raw.decode(errors="replace")
        found = from_config(raw)
        if found is not None:
            return found
    return None


def read_exact(stream: BinaryIO, size: int) -> bytes:
    data = stream.read(size)
    if len(data) != size:
        raise ValueError("the GGUF file ends early")
    return data


def read_u64(stream: BinaryIO) -> int:
    return struct.unpack("<Q", read_exact(stream, 8))[0]


def read_text(stream: BinaryIO) -> str:
    return read_exact(stream, read_u64(stream)).decode(errors="replace")


def skip_value(stream: BinaryIO, kind: int) -> None:
    if kind in FIXED:
        read_exact(stream, FIXED[kind])
    elif kind == STRING:
        stream.seek(read_u64(stream), 1)
    elif kind == ARRAY:
        inner = struct.unpack("<I", read_exact(stream, 4))[0]
        count = read_u64(stream)
        if inner in FIXED:
            stream.seek(FIXED[inner] * count, 1)
        else:
            for _ in range(count):
                skip_value(stream, inner)
    else:
        raise ValueError(f"unknown GGUF value type {kind}")


def gguf_template(stream: BinaryIO) -> str | None:
    try:
        if stream.read(4) != GGUF_MAGIC:
            return None
        read_exact(stream, 4 + 8)
        count = read_u64(stream)
        for _ in range(min(count, MAX_KEYS)):
            key = read_text(stream)
            kind = struct.unpack("<I", read_exact(stream, 4))[0]
            if key == TEMPLATE_KEY and kind == STRING:
                return read_text(stream)
            skip_value(stream, kind)
    except (ValueError, OSError, struct.error):
        return None
    return None
