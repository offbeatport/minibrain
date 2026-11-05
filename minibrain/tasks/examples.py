import json
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

USER = "user"
ASSISTANT = "assistant"
SYSTEM = "system"
ROLES = (USER, ASSISTANT)

Message = dict[str, str]


@dataclass(frozen=True)
class Turn:
    role: str
    content: str

    def as_message(self) -> Message:
        return {"role": self.role, "content": self.content}


@dataclass(frozen=True)
class Example:
    turns: tuple[Turn, ...]
    expected: str

    @property
    def input(self) -> str:
        if len(self.turns) == 1:
            return self.turns[0].content
        return "\n".join(f"{turn.role}: {turn.content}" for turn in self.turns)

    def messages(self) -> list[Message]:
        return [turn.as_message() for turn in self.turns]

    def conversation(self) -> list[Message]:
        return [*self.messages(), {"role": ASSISTANT, "content": self.expected}]


def single(text: str, expected: str) -> Example:
    return Example(turns=(Turn(USER, text),), expected=expected)


def text_of(content: Any) -> str | None:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [part.get("text") for part in content if isinstance(part, dict) and part.get("type") == "text"]
        texts = [part for part in parts if isinstance(part, str)]
        return "".join(texts) if texts else None
    return None


def turns_of(value: Any) -> tuple[Turn, ...] | None:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return None
    if not isinstance(value, list):
        return None
    found: list[Turn] = []
    for item in value:
        if not isinstance(item, dict):
            return None
        role, content = item.get("role"), text_of(item.get("content"))
        if role == SYSTEM:
            continue
        if role not in ROLES or content is None:
            return None
        found.append(Turn(str(role), content))
    return tuple(found)


def well_formed(turns: Sequence[Turn]) -> bool:
    if not turns or turns[0].role != USER:
        return False
    alternating = all(turn.role == ROLES[index % 2] for index, turn in enumerate(turns))
    return alternating and all(turn.content.strip() for turn in turns)


def from_chat(value: Any) -> Example | None:
    turns = turns_of(value)
    if not turns or turns[-1].role != ASSISTANT or not well_formed(turns):
        return None
    return Example(turns=turns[:-1], expected=turns[-1].content)


def from_pair(text: str | None, expected: str | None) -> Example | None:
    if not text or not expected or not text.strip() or not expected.strip():
        return None
    return single(text.strip(), expected.strip())


def encode_turns(turns: Sequence[Turn]) -> str:
    return json.dumps([turn.as_message() for turn in turns], ensure_ascii=False, separators=(",", ":"))


def decode_turns(text: str) -> tuple[Turn, ...]:
    return tuple(Turn(str(item["role"]), str(item["content"])) for item in json.loads(text))


def as_record(example: Example) -> dict[str, Any]:
    return {"messages": example.messages(), "expected": example.expected}


def from_record(record: dict[str, Any]) -> Example:
    return Example(turns=turns_of(record["messages"]) or (), expected=str(record["expected"]))


def assistant_turns(example: Example) -> list[tuple[list[Message], Message]]:
    conversation = example.conversation()
    return [
        (conversation[:index], message)
        for index, message in enumerate(conversation)
        if message["role"] == ASSISTANT and index > 0
    ]
