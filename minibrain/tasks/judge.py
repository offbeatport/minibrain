import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from minibrain.tasks.examples import SYSTEM, USER, Example, Message
from minibrain.tasks.graders import Grader, Judge

GRADES = ("1", "2", "3", "4", "5")
REASON_CHARACTERS = 240
SCALE = re.compile(r"^\s*(?:/\s*5|out of 5)?[\s.:,;)\-\u2013\u2014]*", re.IGNORECASE)
SYSTEM_PROMPT = (
    "You grade one answer against a rubric. Reply with a digit from 1 to 5 first: 1 when the answer fails the "
    "rubric, 5 when it meets it fully. Then, on the same line, give the reason in one short sentence."
)


@dataclass(frozen=True)
class Item:
    key: str
    conversation: str
    expected: str
    answer: str

    def as_dict(self) -> dict[str, str]:
        return {"key": self.key, "conversation": self.conversation, "expected": self.expected, "answer": self.answer}

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "Item":
        return Item(str(data["key"]), str(data["conversation"]), str(data["expected"]), str(data["answer"]))


def messages_for(rubric: str, item: Item, instructions: str = "") -> list[Message]:
    told = f"System prompt the answer had to follow:\n{instructions}\n\n" if instructions else ""
    text = (
        f"Rubric:\n{rubric}\n\n{told}Conversation:\n{item.conversation}\n\n"
        f"Reference answer:\n{item.expected}\n\nAnswer to grade:\n{item.answer}"
    )
    return [{"role": SYSTEM, "content": SYSTEM_PROMPT}, {"role": USER, "content": text}]


def grade_value(output: str) -> float | None:
    found = next((char for char in output.strip() if char.isdigit()), None)
    return (int(found) - 1) / (len(GRADES) - 1) if found in GRADES else None


def reason_of(output: str) -> str | None:
    text = output.strip()
    digit = next((index for index, char in enumerate(text) if char in GRADES), None)
    rest = text[digit + 1 :] if digit is not None else text
    reason = " ".join(SCALE.sub("", rest, count=1).split())
    return reason[:REASON_CHARACTERS] or None


def judge_of(graders: Sequence[Grader]) -> Judge | None:
    return next((grader for grader in graders if isinstance(grader, Judge)), None)


def pending_items(judge: Judge, examples: Sequence[Example], answers: Sequence[str]) -> list[Item]:
    found: dict[str, Item] = {}
    for example, answer in zip(examples, answers, strict=True):
        key = judge.key(answer, example)
        if key not in judge.found and key not in found:
            found[key] = Item(key, example.input, example.expected, answer)
    return list(found.values())
