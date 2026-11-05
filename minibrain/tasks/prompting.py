from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from minibrain.serve.structured import Constraint
from minibrain.tasks.contracts import Contract, constraint
from minibrain.tasks.examples import ROLES, SYSTEM, Example, Message, as_record, from_record


class PromptError(ValueError):
    pass


@dataclass(frozen=True)
class Prompting:
    instructions: str
    contract: Contract
    shots: tuple[Example, ...] = ()
    trained: bool = False

    def messages(self, conversation: Sequence[Message]) -> list[Message]:
        turns = [
            {"role": message["role"], "content": message["content"]}
            for message in conversation
            if message.get("role") in ROLES and message.get("content")
        ]
        if not turns or turns[-1]["role"] != ROLES[0]:
            raise PromptError("a user message with text content is required, and it has to come last")
        shots = [] if self.trained else [message for shot in self.shots for message in shot.conversation()]
        system = [{"role": SYSTEM, "content": self.instructions}] if self.instructions else []
        return [*system, *shots, *turns]

    def constraint(self) -> Constraint | None:
        return constraint(self.contract)

    def as_dict(self) -> dict[str, Any]:
        return {
            "instructions": self.instructions,
            "contract": self.contract.as_dict(),
            "shots": [as_record(shot) for shot in self.shots],
            "trained": self.trained,
        }

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "Prompting":
        return Prompting(
            instructions=str(data.get("instructions") or ""),
            contract=Contract.from_dict(data.get("contract")),
            shots=tuple(from_record(record) for record in data.get("shots") or ()),
            trained=bool(data.get("trained")),
        )
