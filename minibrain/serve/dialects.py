import json
import re
import secrets
import string
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

from minibrain.base_models import BaseModelSpec
from minibrain.ml.completion import Piece, ToolCall, call_id

HERMES = "hermes"
LLAMA3 = "llama3"
MISTRAL = "mistral"
HARMONY = "harmony"

TOGGLE = "toggle"
EFFORT = "effort"
ALWAYS = "always"
EFFORTS = ("low", "medium", "high")
TAGS = "tags"
OPEN = "open"

LLAMA_GUARD = "llama-guard"
SHIELDGEMMA = "shieldgemma"
QWEN3GUARD = "qwen3guard"
SAFEGUARD = "gpt-oss-safeguard"

AUTO = "auto"
NONE = "none"
REQUIRED = "required"

THINK_OPEN = "<think>"
THINK_CLOSE = "</think>"
OPENED_THINKING = re.compile("(?:assistant|Assistant\\uff5c>)(?:\\\\n|\\n)*<think>(?!(?:\\\\n|\\n)*</think>)")

HERMES_OPEN = "<tool_call>"
HERMES_CLOSE = "</tool_call>"
PYTHON_TAG = "<|python_tag|>"
MISTRAL_CALLS = "[TOOL_CALLS]"
HARMONY_CHANNEL = "<|channel|>"
HARMONY_MESSAGE = "<|message|>"
HARMONY_START = "<|start|>"
HARMONY_ENDS = ("<|end|>", "<|call|>", "<|return|>")
RECIPIENT = re.compile(r"to=functions\.([\w.-]+)")
CHANNEL_NAME = re.compile(r"<\|channel\|>(\w+)")
MISTRAL_ID_CHARACTERS = string.ascii_letters + string.digits


def detect_tools(template: str | None) -> str | None:
    if not template:
        return None
    if HARMONY_CHANNEL in template:
        return HARMONY
    if "<arg_key>" in template:
        return None
    if HERMES_OPEN in template:
        return HERMES
    if MISTRAL_CALLS in template:
        return MISTRAL
    if PYTHON_TAG in template or ('"parameters"' in template and "ipython" in template):
        return LLAMA3
    return None


def detect_guard(repo: str | None, name: str | None = None) -> str | None:
    text = f"{repo or ''} {name or ''}".lower().replace("_", "-").replace(" ", "-")
    if "llama-guard" in text:
        return LLAMA_GUARD
    if "shieldgemma" in text:
        return SHIELDGEMMA
    if "qwen3guard" in text:
        return QWEN3GUARD
    if "gpt-oss-safeguard" in text:
        return SAFEGUARD
    return None


def detect_reasoning(template: str | None) -> str | None:
    if not template:
        return None
    if "reasoning_effort" in template:
        return EFFORT
    if "enable_thinking" in template:
        return TOGGLE
    if OPENED_THINKING.search(template):
        return ALWAYS
    return None


def reasoning_choices(style: str | None) -> tuple[str, ...]:
    if style == TOGGLE:
        return (NONE, *EFFORTS)
    if style == EFFORT:
        return EFFORTS
    return ()


def reasoning_kwargs(style: str | None, effort: str | None) -> dict[str, Any]:
    if effort is None:
        return {}
    if style == TOGGLE:
        return {"enable_thinking": effort != NONE}
    if style == EFFORT:
        return {"reasoning_effort": effort}
    return {}


def think_mode(style: str | None, kwargs: dict[str, Any]) -> str | None:
    if style == ALWAYS:
        return OPEN
    if style == TOGGLE and kwargs.get("enable_thinking", True):
        return TAGS
    return None


def mistral_id() -> str:
    return "".join(secrets.choice(MISTRAL_ID_CHARACTERS) for _ in range(9))


def held(text: str, markers: tuple[str, ...]) -> int:
    longest = 0
    for marker in markers:
        for size in range(min(len(marker) - 1, len(text)), 0, -1):
            if marker.startswith(text[-size:]):
                longest = max(longest, size)
                break
    return longest


def arguments_text(value: Any) -> str:
    return value if isinstance(value, str) else json.dumps(value if value is not None else {}, ensure_ascii=False)


def call_from(found: Any, maker: Callable[[], str] = call_id) -> ToolCall | None:
    if not isinstance(found, dict) or not isinstance(found.get("name"), str):
        return None
    arguments = found.get("arguments", found.get("parameters", {}))
    return ToolCall(name=found["name"], arguments=arguments_text(arguments), id=maker())


def json_values(text: str) -> list[Any] | None:
    decoder = json.JSONDecoder()
    found: list[Any] = []
    position = 0
    while True:
        while position < len(text) and text[position] in " \t\r\n;,":
            position += 1
        if position >= len(text):
            return found
        try:
            value, position = decoder.raw_decode(text, position)
        except json.JSONDecodeError:
            return None
        found.append(value)


class Reader(Protocol):
    def feed(self, text: str) -> Piece: ...

    def finish(self) -> Piece: ...


@dataclass
class PlainReader:
    def feed(self, text: str) -> Piece:
        return Piece(content=text)

    def finish(self) -> Piece:
        return Piece()


@dataclass
class ThinkReader:
    opened: bool = False
    buffer: str = ""
    state: str = "start"

    def __post_init__(self) -> None:
        self.state = "opening" if self.opened else "start"

    def feed(self, text: str) -> Piece:
        self.buffer += text
        found = Piece()
        while True:
            step = self.step()
            if step is None:
                return found
            found += step

    def step(self) -> Piece | None:
        if self.state in ("start", "opening"):
            stripped = self.buffer.lstrip()
            if not stripped or (THINK_OPEN.startswith(stripped) and stripped != THINK_OPEN):
                return None
            if stripped.startswith(THINK_OPEN):
                self.buffer, self.state = stripped[len(THINK_OPEN) :].lstrip(), "thinking"
            else:
                self.buffer, self.state = stripped, "thinking" if self.state == "opening" else "content"
            return Piece()
        if self.state == "thinking":
            end = self.buffer.find(THINK_CLOSE)
            if end >= 0:
                thought, self.buffer, self.state = self.buffer[:end], self.buffer[end + len(THINK_CLOSE) :], "after"
                return Piece(reasoning=thought)
            keep = held(self.buffer, (THINK_CLOSE,))
            thought, self.buffer = self.buffer[: len(self.buffer) - keep], self.buffer[len(self.buffer) - keep :]
            return Piece(reasoning=thought) if thought else None
        if self.state == "after":
            self.buffer = self.buffer.lstrip()
            if not self.buffer:
                return None
            self.state = "content"
            return Piece()
        text, self.buffer = self.buffer, ""
        return Piece(content=text) if text else None

    def finish(self) -> Piece:
        rest, self.buffer = self.buffer, ""
        if self.state == "thinking" or (self.state == "opening" and rest.strip()):
            return Piece(reasoning=rest.removeprefix(THINK_OPEN) if self.state == "opening" else rest)
        return Piece(content=rest.lstrip() if self.state in ("start", "after") else rest)


@dataclass
class HermesReader:
    buffer: str = ""
    inside: bool = False
    trim: bool = True

    def feed(self, text: str) -> Piece:
        self.buffer += text
        found = Piece()
        while True:
            if self.inside:
                end = self.buffer.find(HERMES_CLOSE)
                if end < 0:
                    return found
                found += self.parsed(self.buffer[:end])
                self.buffer = self.buffer[end + len(HERMES_CLOSE) :]
                self.inside = False
                self.trim = True
                continue
            start = self.buffer.find(HERMES_OPEN)
            if start >= 0:
                found += self.content(self.buffer[:start])
                self.buffer = self.buffer[start + len(HERMES_OPEN) :]
                self.inside = True
                continue
            keep = held(self.buffer, (HERMES_OPEN,))
            found += self.content(self.buffer[: len(self.buffer) - keep])
            self.buffer = self.buffer[len(self.buffer) - keep :]
            return found

    def content(self, text: str) -> Piece:
        if self.trim:
            text = text.lstrip()
            self.trim = not text
        return Piece(content=text)

    def parsed(self, text: str) -> Piece:
        call = call_from(json_one(text))
        return Piece(tool_calls=(call,)) if call else Piece(content=f"{HERMES_OPEN}{text}{HERMES_CLOSE}")

    def finish(self) -> Piece:
        rest, self.buffer = self.buffer, ""
        if self.inside:
            self.inside = False
            call = call_from(json_one(rest))
            return Piece(tool_calls=(call,)) if call else Piece(content=f"{HERMES_OPEN}{rest}")
        return self.content(rest)


def json_one(text: str) -> Any:
    found = json_values(text.strip())
    return found[0] if found and len(found) == 1 else None


@dataclass
class JsonCallsReader:
    marker: str
    maker: Callable[[], str] = call_id
    leading_json: bool = False
    buffer: str = ""
    mode: str = "start"

    def feed(self, text: str) -> Piece:
        self.buffer += text
        if self.mode == "content":
            return self.content()
        if self.mode == "calls":
            return Piece()
        stripped = self.buffer.lstrip()
        if not stripped:
            return Piece()
        if stripped.startswith(self.marker) or (self.leading_json and stripped.startswith(("{", "["))):
            self.mode = "calls"
            return Piece()
        if self.marker.startswith(stripped):
            return Piece()
        self.mode = "content"
        self.buffer = stripped
        return self.content()

    def content(self) -> Piece:
        start = self.buffer.find(self.marker)
        if start >= 0:
            text, self.buffer, self.mode = self.buffer[:start], self.buffer[start:], "calls"
            return Piece(content=text)
        keep = held(self.buffer, (self.marker,))
        text, self.buffer = self.buffer[: len(self.buffer) - keep], self.buffer[len(self.buffer) - keep :]
        return Piece(content=text)

    def finish(self) -> Piece:
        rest, self.buffer = self.buffer, ""
        if self.mode != "calls":
            return Piece(content=rest.lstrip() if self.mode == "start" else rest)
        body = rest.strip().removeprefix(self.marker)
        values = json_values(body)
        flat = [item for value in values or [] for item in (value if isinstance(value, list) else [value])]
        calls = [call_from(item, self.maker) for item in flat]
        if not flat or any(call is None for call in calls):
            return Piece(content=rest.strip())
        return Piece(tool_calls=tuple(call for call in calls if call is not None))


@dataclass
class HarmonyReader:
    buffer: str = ""
    header: str | None = None
    body: str = ""
    seen: bool = False

    def feed(self, text: str) -> Piece:
        self.buffer += text
        found = Piece()
        while True:
            if self.header is None:
                start = self.buffer.find(HARMONY_CHANNEL)
                if start < 0:
                    if not self.seen and self.buffer.strip() and not HARMONY_CHANNEL.startswith(self.buffer.strip()):
                        found += Piece(content=self.buffer)
                        self.buffer = ""
                    return found
                self.seen = True
                opened = self.buffer.find(HARMONY_MESSAGE, start)
                if opened < 0:
                    return found
                self.header = self.buffer[:opened]
                self.buffer = self.buffer[opened + len(HARMONY_MESSAGE) :]
                self.body = ""
                continue
            ends = [index for index in (self.buffer.find(end) for end in HARMONY_ENDS) if index >= 0]
            if not ends:
                keep = held(self.buffer, HARMONY_ENDS)
                found += self.flow(self.buffer[: len(self.buffer) - keep])
                self.buffer = self.buffer[len(self.buffer) - keep :]
                return found
            end = min(ends)
            found += self.flow(self.buffer[:end]) + self.closed()
            rest = self.buffer[end:]
            closer = next(marker for marker in HARMONY_ENDS if rest.startswith(marker))
            self.buffer = rest[len(closer) :].removeprefix(HARMONY_START).removeprefix("assistant")
            self.header = None

    def channel(self) -> str:
        found = CHANNEL_NAME.search(self.header or "")
        return found.group(1) if found else ""

    def recipient(self) -> str | None:
        found = RECIPIENT.search(self.header or "")
        return found.group(1) if found else None

    def flow(self, text: str) -> Piece:
        if self.recipient() is not None:
            self.body += text
            return Piece()
        if self.channel() == "analysis":
            return Piece(reasoning=text)
        return Piece(content=text)

    def closed(self) -> Piece:
        name = self.recipient()
        if name is None:
            return Piece()
        body, self.body = self.body, ""
        return Piece(tool_calls=(ToolCall(name=name, arguments=body.strip() or "{}"),))

    def finish(self) -> Piece:
        if self.header is None:
            rest, self.buffer = self.buffer, ""
            return Piece(content=rest) if not self.seen else Piece()
        found = self.flow(self.buffer) + self.closed()
        self.buffer, self.header = "", None
        return found


@dataclass
class Chain:
    first: Reader
    second: Reader

    def passed(self, piece: Piece) -> Piece:
        if not piece.content:
            return piece
        return Piece(tool_calls=piece.tool_calls, reasoning=piece.reasoning) + self.second.feed(piece.content)

    def feed(self, text: str) -> Piece:
        return self.passed(self.first.feed(text))

    def finish(self) -> Piece:
        return self.passed(self.first.finish()) + self.second.finish()


@dataclass
class OneCall:
    inner: Reader
    calls: int = 0
    limit: int | None = None

    def kept(self, piece: Piece) -> Piece:
        if self.limit is None:
            return piece
        room = max(self.limit - self.calls, 0)
        kept = piece.tool_calls[:room]
        self.calls += len(kept)
        return Piece(content=piece.content, tool_calls=kept, reasoning=piece.reasoning)

    def feed(self, text: str) -> Piece:
        return self.kept(self.inner.feed(text))

    def finish(self) -> Piece:
        return self.kept(self.inner.finish())


def tool_reader(fmt: str | None) -> Reader:
    if fmt == HERMES:
        return HermesReader()
    if fmt == LLAMA3:
        return JsonCallsReader(PYTHON_TAG, leading_json=True)
    if fmt == MISTRAL:
        return JsonCallsReader(MISTRAL_CALLS, maker=mistral_id)
    return PlainReader()


@dataclass(frozen=True)
class ToolUse:
    tools: tuple[dict[str, Any], ...] = ()
    choice: str | dict[str, Any] | None = None
    parallel: bool = True

    @property
    def active(self) -> bool:
        return bool(self.tools) and self.mode != NONE

    @property
    def mode(self) -> str:
        if isinstance(self.choice, dict):
            return REQUIRED
        return self.choice or (AUTO if self.tools else NONE)

    @property
    def function(self) -> str | None:
        if isinstance(self.choice, dict):
            found = (self.choice.get("function") or {}).get("name")
            return str(found) if found else None
        return None


def reader_for(fmt: str | None, use: ToolUse, think: str | None = None) -> Reader:
    if fmt == HARMONY:
        inner: Reader = HarmonyReader()
    else:
        inner = tool_reader(fmt) if use.active else PlainReader()
        if think is not None:
            inner = Chain(ThinkReader(opened=think == OPEN), inner)
    return OneCall(inner, limit=None if use.parallel else 1)


def answer_text(spec: BaseModelSpec, text: str) -> str:
    think = think_mode(spec.reasoning, spec.template_kwargs)
    return read_all(reader_for(spec.tools, ToolUse(), think), text).content


def prefill(fmt: str | None, use: ToolUse) -> str:
    if not use.active or use.mode != REQUIRED:
        return ""
    name = use.function
    if fmt == HERMES:
        return f'{HERMES_OPEN}\n{{"name": "{name}", "arguments": ' if name else f"{HERMES_OPEN}\n"
    if fmt == LLAMA3:
        return f'{{"name": "{name}", "parameters": ' if name else '{"name": "'
    if fmt == MISTRAL:
        return f'{MISTRAL_CALLS}[{{"name": "{name}", "arguments": ' if name else MISTRAL_CALLS
    if fmt == HARMONY:
        target = f"{HARMONY_CHANNEL}commentary to=functions."
        return f"{target}{name} <|constrain|>json{HARMONY_MESSAGE}" if name else target
    return ""


def template_message(message: dict[str, Any]) -> dict[str, Any]:
    found = dict(message)
    if found.get("content") is None:
        found["content"] = ""
    calls = found.get("tool_calls")
    if calls:
        found["tool_calls"] = [template_call(call) for call in calls]
    return found


def template_call(call: dict[str, Any]) -> dict[str, Any]:
    function = dict(call.get("function") or {})
    raw = function.get("arguments")
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict):
            function["arguments"] = parsed
    return {**call, "function": function}


def template_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [template_message(message) for message in messages]


def read_all(reader: Reader, text: str) -> Piece:
    return reader.feed(text) + reader.finish()
