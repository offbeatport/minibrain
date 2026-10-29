from dataclasses import dataclass


@dataclass(frozen=True)
class Completion:
    text: str
    prompt_tokens: int
    completion_tokens: int
    stopped: bool
    seconds: float
