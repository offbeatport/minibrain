from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Call:
    request_id: str
    response_id: str | None = None
    operation: str | None = None
    request_model: str | None = None
    model_known: bool = False
    response_model: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    finish_reasons: tuple[str, ...] = ()
    max_tokens: int | None = None
    error_type: str | None = None
    labels: dict[str, Any] = field(default_factory=dict)


CURRENT: ContextVar[Call | None] = ContextVar("minibrain_call", default=None)


def current_call() -> Call | None:
    return CURRENT.get()
