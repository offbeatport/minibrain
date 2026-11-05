from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from minibrain.tasks.examples import SYSTEM, USER, Example, Message
from minibrain.tasks.graders import Grader, Judge

GRADES = ("1", "2", "3", "4", "5")
SYSTEM_PROMPT = (
    "You grade one answer against a rubric. Reply with a single digit from 1 to 5: 1 when the answer fails the "
    "rubric, 5 when it meets it fully."
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


def messages_for(rubric: str, item: Item) -> list[Message]:
    text = (
        f"Rubric:\n{rubric}\n\nConversation:\n{item.conversation}\n\nReference answer:\n{item.expected}\n\n"
        f"Answer to grade:\n{item.answer}"
    )
    return [{"role": SYSTEM, "content": SYSTEM_PROMPT}, {"role": USER, "content": text}]


def grade_value(output: str) -> float | None:
    found = next((char for char in output.strip() if char.isdigit()), None)
    return (int(found) - 1) / (len(GRADES) - 1) if found in GRADES else None


def judge_of(graders: Sequence[Grader]) -> Judge | None:
    return next((grader for grader in graders if isinstance(grader, Judge)), None)


def pending_items(judge: Judge, examples: Sequence[Example], answers: Sequence[str]) -> list[Item]:
    found: dict[str, Item] = {}
    for example, answer in zip(examples, answers, strict=True):
        key = judge.key(answer, example)
        if key not in judge.found and key not in found:
            found[key] = Item(key, example.input, example.expected, answer)
    return list(found.values())
