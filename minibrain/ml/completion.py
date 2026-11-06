from dataclasses import asdict, dataclass
from typing import Any

STOP = "stop"
LENGTH = "length"


@dataclass(frozen=True)
class Completion:
    text: str
    prompt_tokens: int
    completion_tokens: int
    stopped: bool
    seconds: float

    @property
    def finish_reason(self) -> str:
        return STOP if self.stopped else LENGTH

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "Completion":
        return Completion(
            text=str(data.get("text") or ""),
            prompt_tokens=int(data.get("prompt_tokens") or 0),
            completion_tokens=int(data.get("completion_tokens") or 0),
            stopped=bool(data.get("stopped")),
            seconds=float(data.get("seconds") or 0.0),
        )
