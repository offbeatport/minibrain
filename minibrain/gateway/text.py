import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass, replace
from typing import Any

from minibrain.base_models import BaseModelSpec
from minibrain.gateway.chat import ChatPlan, Finished, events_sse, sampling_of, usage, usage_endings
from minibrain.gateway.config import Route
from minibrain.gateway.errors import invalid
from minibrain.gateway.safety import SafetyPlan, Verdict
from minibrain.gateway.schema import TextCompletionRequest
from minibrain.ml.completion import Completion, Piece
from minibrain.serve.backend import AdapterRef, CompletionRequest, Event

PROMPT = "prompt"
UNSUPPORTED = "unsupported_parameter"


def prompt_of(raw: str | list[str] | list[int] | list[list[int]]) -> str:
    if isinstance(raw, str):
        return raw
    if not raw:
        raise invalid(PROMPT, "prompt needs a text to continue.")
    if not all(isinstance(item, str) for item in raw):
        raise invalid(PROMPT, "prompt is read as text; token ids are not supported.", "unsupported_value")
    if len(raw) > 1:
        message = f"prompt takes one text per request, not {len(raw)}; send each text in its own request."
        raise invalid(PROMPT, message, "unsupported_value")
    return str(raw[0])


def kept_prompt(raw: Any) -> str | None:
    found = raw if isinstance(raw, str) else raw[0] if raw and isinstance(raw[0], str) else None
    return found or None


def refuse_unsupported(body: TextCompletionRequest) -> None:
    if body.logprobs is not None:
        raise invalid("logprobs", "logprobs are not returned; leave logprobs unset.", UNSUPPORTED)
    if body.echo:
        raise invalid("echo", "echo is not supported; leave it unset or false.", UNSUPPORTED)
    if body.suffix:
        raise invalid("suffix", "suffix (fill in the middle) is not supported; leave it unset.", UNSUPPORTED)
    if (body.model_extra or {}).get("logit_bias"):
        raise invalid("logit_bias", "logit_bias is not supported; leave it unset.", UNSUPPORTED)


def bare(route: Route) -> Route:
    return replace(route, prompting=None)


def text_plan(
    body: TextCompletionRequest,
    route: Route,
    base: BaseModelSpec,
    adapter: AdapterRef | None = None,
    safety: SafetyPlan | None = None,
) -> ChatPlan:
    refuse_unsupported(body)
    prompt = prompt_of(body.prompt)
    request = CompletionRequest(
        base=base,
        messages=[],
        adapter=adapter,
        max_tokens=body.token_budget,
        route=route.name,
        sampling=sampling_of(body, route),
        prompt=prompt,
    )
    return ChatPlan(bare(route), request, None, [{"role": "user", "content": prompt}], safety)


def text_id() -> str:
    return f"cmpl-{uuid.uuid4().hex}"


def text_choice(text: str, finish_reason: str | None) -> dict[str, Any]:
    return {"index": 0, "text": text, "logprobs": None, "finish_reason": finish_reason}


def text_body(identifier: str, model: str, completion: Completion, verdict: Verdict | None = None) -> dict[str, Any]:
    found = {
        "id": identifier,
        "object": "text_completion",
        "created": int(time.time()),
        "model": model,
        "choices": [text_choice(completion.text, completion.finish_reason)],
        "usage": usage(completion),
    }
    return found | ({"safety": verdict.as_dict()} if verdict is not None else {})


@dataclass
class TextChunks:
    include_usage: bool = False

    def piece(self, piece: Piece) -> dict[str, Any] | None:
        return {"choices": [text_choice(piece.content, None)]} if piece.content else None

    def ending(self, final: Completion) -> list[dict[str, Any]]:
        return usage_endings(text_choice("", final.finish_reason), final, self.include_usage)


def text_sse(
    identifier: str,
    model: str,
    first: Event,
    events: Iterator[Event],
    include_usage: bool = False,
    finished: Finished | None = None,
) -> Iterator[str]:
    head = {"id": identifier, "object": "text_completion", "created": int(time.time()), "model": model}
    return events_sse(head, first, events, TextChunks(include_usage), finished)
