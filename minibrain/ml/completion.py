import secrets
from dataclasses import dataclass, field
from typing import Any

STOP = "stop"
LENGTH = "length"
TOOL_CALLS = "tool_calls"
CONTENT_FILTER = "content_filter"


def call_id() -> str:
    return f"call_{secrets.token_hex(12)}"


@dataclass(frozen=True)
class ToolCall:
    name: str
    arguments: str
    id: str = field(default_factory=call_id)

    def as_openai(self) -> dict[str, Any]:
        return {"id": self.id, "type": "function", "function": {"name": self.name, "arguments": self.arguments}}

    def as_dict(self) -> dict[str, str]:
        return {"id": self.id, "name": self.name, "arguments": self.arguments}

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "ToolCall":
        return ToolCall(name=str(data["name"]), arguments=str(data.get("arguments") or "{}"), id=str(data["id"]))


def calls_of(found: Any) -> tuple[ToolCall, ...]:
    return tuple(ToolCall.from_dict(call) for call in found or ())


@dataclass(frozen=True)
class Completion:
    text: str
    prompt_tokens: int
    completion_tokens: int
    stopped: bool
    seconds: float
    tool_calls: tuple[ToolCall, ...] = ()
    reasoning: str | None = None
    refusal: str | None = None

    @property
    def finish_reason(self) -> str:
        if self.refusal:
            return CONTENT_FILTER
        if self.tool_calls:
            return TOOL_CALLS
        return STOP if self.stopped else LENGTH

    def as_dict(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "stopped": self.stopped,
            "seconds": self.seconds,
            "tool_calls": [call.as_dict() for call in self.tool_calls],
            "reasoning": self.reasoning,
        }

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "Completion":
        return Completion(
            text=str(data.get("text") or ""),
            prompt_tokens=int(data.get("prompt_tokens") or 0),
            completion_tokens=int(data.get("completion_tokens") or 0),
            stopped=bool(data.get("stopped")),
            seconds=float(data.get("seconds") or 0.0),
            tool_calls=calls_of(data.get("tool_calls")),
            reasoning=data.get("reasoning") or None,
        )


@dataclass(frozen=True)
class Piece:
    content: str = ""
    tool_calls: tuple[ToolCall, ...] = ()
    reasoning: str = ""
    refusal: str = ""

    def __bool__(self) -> bool:
        return bool(self.content or self.tool_calls or self.reasoning or self.refusal)

    def __add__(self, other: "Piece") -> "Piece":
        return Piece(self.content + other.content, self.tool_calls + other.tool_calls, self.reasoning + other.reasoning)

    def as_dict(self) -> dict[str, Any]:
        calls = [call.as_dict() for call in self.tool_calls]
        return {"content": self.content, "tool_calls": calls, "reasoning": self.reasoning}

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "Piece":
        return Piece(
            content=str(data.get("content") or ""),
            tool_calls=calls_of(data.get("tool_calls")),
            reasoning=str(data.get("reasoning") or ""),
        )
