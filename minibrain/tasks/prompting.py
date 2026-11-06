from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from minibrain.serve.structured import Constraint
from minibrain.tasks.contracts import Contract, constraint
from minibrain.tasks.examples import ROLES, SYSTEM, Example, as_record, from_record

TOOL = "tool"
LAST_ROLES = (ROLES[0], TOOL)
TOOL_FIELDS = ("tool_calls", "tool_call_id", "name")


class PromptError(ValueError):
    pass


def kept(message: dict[str, Any]) -> bool:
    role = message.get("role")
    if role == TOOL:
        return True
    return role in ROLES and bool(message.get("content") or message.get("tool_calls"))


def turn_of(message: dict[str, Any]) -> dict[str, Any]:
    extra = {key: message[key] for key in TOOL_FIELDS if message.get(key)}
    return {"role": message["role"], "content": message.get("content") or ""} | extra


@dataclass(frozen=True)
class Prompting:
    instructions: str
    contract: Contract
    shots: tuple[Example, ...] = ()
    trained: bool = False

    def messages(self, conversation: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
        turns = [turn_of(message) for message in conversation if kept(message)]
        if not turns or turns[-1]["role"] not in LAST_ROLES:
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
