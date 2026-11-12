import itertools
import json
import logging
import re
import time
import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field, replace
from typing import Any, Protocol

from fastapi import HTTPException

from minibrain.base_models import BaseModelSpec, base_model
from minibrain.gateway.config import GatewayConfig, Route
from minibrain.gateway.errors import OpenAIError, invalid
from minibrain.gateway.safety import SafetyPlan, SafetyUnavailableError, Verdict, judged
from minibrain.gateway.schema import ChatCompletionRequest, Message, TextCompletionRequest
from minibrain.ml.completion import Completion, Piece
from minibrain.models.health import base_changed
from minibrain.serve.backend import (
    AdapterRef,
    CompletionRequest,
    EngineUnavailableError,
    Event,
    OutputFormatError,
    ServingBackend,
)
from minibrain.serve.dialects import ALWAYS, AUTO, EFFORT, NONE, REQUIRED, ToolUse, reasoning_choices
from minibrain.serve.sampling import MAX_STOPS, Sampling, UnsupportedParameterError
from minibrain.serve.structured import JSON_OBJECT, Constraint, schema_problem, unfenced, violation
from minibrain.tasks.contracts import JSON, TEXT, Contract
from minibrain.tasks.prompting import PromptError, Prompting

log = logging.getLogger("minibrain.gateway")

FORMAT = "response_format"
SCHEMA_FORMAT = f"{FORMAT}.json_schema"
FORMAT_NAME = re.compile(r"[A-Za-z0-9_-]{1,64}")
FUNCTION_NAME = re.compile(r"[A-Za-z0-9_-]{1,64}")
UNCONSTRAINED = "only SGLang and llama.cpp engines constrain decoding, the others check the answer afterwards."
ROLES = ("system", "developer", "user", "assistant", "tool")
CHOICES = (AUTO, NONE, REQUIRED)
Requested = ChatCompletionRequest | TextCompletionRequest


def spec_for(config: GatewayConfig, key: str) -> BaseModelSpec:
    found = config.bases.get(key)
    return BaseModelSpec.from_dict(found) if found else base_model(key)


def prompting(route: Route) -> Prompting | None:
    return Prompting.from_dict(route.prompting) if route.kind != "base" and route.prompting else None


def route_contract(route: Route) -> Contract | None:
    found = prompting(route)
    return found.contract if found is not None else None


def task_constraint(route: Route) -> Constraint | None:
    found = prompting(route)
    return found.constraint() if found is not None else None


def contract_schema(route: Route) -> dict[str, Any] | None:
    contract = route_contract(route)
    if contract is None or contract.kind != JSON or contract.labels is not None:
        return None
    return contract.schema


def served_model(route: Route) -> str:
    return route.slug if route.version is None else f"{route.slug}@{route.version}"


def held_by(route: Route) -> str | None:
    contract = route_contract(route)
    if contract is None or contract.kind == TEXT:
        return None
    return "one of its labels" if contract.labels is not None else "its JSON schema"


def route_messages(route: Route, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    found = prompting(route)
    if found is None:
        return messages
    try:
        return found.messages(messages)
    except PromptError as error:
        raise invalid("messages", f"{error}.") from error


def schema_format(spec: Any) -> dict[str, Any]:
    if not isinstance(spec, dict):
        message = "response_format.json_schema is required when response_format.type is json_schema."
        raise invalid(SCHEMA_FORMAT, message, "missing_required_parameter")
    name = spec.get("name")
    if not isinstance(name, str) or not FORMAT_NAME.fullmatch(name):
        message = "response_format.json_schema.name must be 1-64 letters, digits, underscores or dashes."
        raise invalid(f"{SCHEMA_FORMAT}.name", message)
    if spec.get("strict") is not None and not isinstance(spec["strict"], bool):
        raise invalid(f"{SCHEMA_FORMAT}.strict", "response_format.json_schema.strict must be true or false.")
    schema = spec.get("schema")
    if not isinstance(schema, dict):
        message = "response_format.json_schema.schema must be a JSON Schema object."
        raise invalid(
            f"{SCHEMA_FORMAT}.schema", message, "missing_required_parameter" if schema is None else "invalid_value"
        )
    problem = schema_problem(schema)
    if problem is not None:
        raise invalid(f"{SCHEMA_FORMAT}.schema", f"Invalid JSON Schema: {problem}.")
    return schema


def requested_format(raw: Any) -> Constraint | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise invalid(FORMAT, 'response_format must be an object such as {"type": "json_object"}.')
    kind = raw.get("type")
    if kind == "text":
        return None
    if kind == "json_object":
        return Constraint(json_schema=JSON_OBJECT)
    if kind != "json_schema":
        raise invalid(f"{FORMAT}.type", "response_format.type must be text, json_object or json_schema.")
    return Constraint(json_schema=schema_format(raw.get("json_schema")))


def narrowed(route: Route, requested: Constraint | None) -> Constraint | None:
    held = held_by(route)
    if requested is None or held is None:
        return requested
    message = (
        f"{served_model(route)} answers with {held}, its contract; response_format can only narrow a model whose "
        "contract is free text. Leave response_format out to get the contract's answer."
    )
    raise invalid(FORMAT, message, "unsupported_value")


def stops_of(raw: str | list[str] | None) -> tuple[str, ...]:
    found = [raw] if isinstance(raw, str) else list(raw or [])
    if len(found) > MAX_STOPS:
        raise invalid("stop", f"stop takes at most {MAX_STOPS} texts.")
    if any(not text for text in found):
        raise invalid("stop", "Each stop text needs at least one character.")
    return tuple(found)


def sampling_of(body: Requested, route: Route) -> Sampling:
    sampling = Sampling(
        temperature=body.temperature,
        top_p=body.top_p,
        top_k=body.top_k,
        min_p=body.min_p,
        presence_penalty=body.presence_penalty,
        frequency_penalty=body.frequency_penalty,
        repetition_penalty=body.repetition_penalty,
        seed=body.seed,
        stop=stops_of(body.stop),
    )
    return sampling if route.kind == "base" else sampling.or_greedy()


def refuse_unsupported(body: ChatCompletionRequest) -> None:
    extra = body.model_extra or {}
    if extra.get("logprobs"):
        raise invalid("logprobs", "logprobs are not returned; leave logprobs unset.", "unsupported_parameter")
    if extra.get("logit_bias"):
        raise invalid("logit_bias", "logit_bias is not supported; leave it unset.", "unsupported_parameter")
    if extra.get("functions") or extra.get("function_call"):
        message = "functions and function_call are the old names; send tools and tool_choice instead."
        raise invalid("functions", message, "unsupported_parameter")


def text_of(content: str | list[dict[str, Any]] | None, where: str) -> str:
    if content is None or isinstance(content, str):
        return content or ""
    parts: list[str] = []
    for index, part in enumerate(content):
        if part.get("type") != "text" or not isinstance(part.get("text"), str):
            kind = part.get("type") or "unknown"
            raise invalid(f"{where}.content[{index}]", f"Only text parts are read; this one is {kind}.")
        parts.append(part["text"])
    return "".join(parts)


def message_of(message: Message, index: int) -> dict[str, Any]:
    where = f"messages[{index}]"
    if message.role not in ROLES:
        raise invalid(f"{where}.role", f"role must be one of {', '.join(ROLES)}.")
    role = "system" if message.role == "developer" else message.role
    found: dict[str, Any] = {"role": role, "content": text_of(message.content, where)}
    if message.tool_calls and role == "assistant":
        found["tool_calls"] = [call.model_dump() for call in message.tool_calls]
    if role == "tool":
        if not message.tool_call_id:
            raise invalid(f"{where}.tool_call_id", "A tool message needs the tool_call_id of the call it answers.")
        found["tool_call_id"] = message.tool_call_id
        if message.name:
            found["name"] = message.name
    return found


def plain(messages: list[Message]) -> list[dict[str, Any]]:
    return [message_of(message, index) for index, message in enumerate(messages)]


def function_names(body: ChatCompletionRequest) -> list[str]:
    names: list[str] = []
    for index, tool in enumerate(body.tools or []):
        where = f"tools[{index}].function"
        name = tool.function.name
        if not FUNCTION_NAME.fullmatch(name):
            raise invalid(f"{where}.name", "A function name is 1-64 letters, digits, underscores or dashes.")
        if name in names:
            raise invalid(f"{where}.name", f"Two tools are named {name}.")
        parameters = tool.function.parameters
        problem = schema_problem(parameters) if parameters is not None else None
        if problem is not None:
            raise invalid(f"{where}.parameters", f"Invalid JSON Schema: {problem}.")
        names.append(name)
    return names


def choice_of(raw: str | dict[str, Any] | None, names: list[str]) -> str | dict[str, Any] | None:
    if raw is None:
        return None
    if not names:
        raise invalid("tool_choice", "tool_choice needs tools.")
    if isinstance(raw, str):
        if raw not in CHOICES:
            raise invalid("tool_choice", f"tool_choice must be {', '.join(CHOICES)} or a named function.")
        return raw
    name = (raw.get("function") or {}).get("name") if raw.get("type") == "function" else None
    if not isinstance(name, str):
        raise invalid("tool_choice", 'A named tool_choice is {"type": "function", "function": {"name": ...}}.')
    if name not in names:
        raise invalid("tool_choice.function.name", f"No tool is named {name}.")
    return {"type": "function", "function": {"name": name}}


def tool_use_of(body: ChatCompletionRequest) -> ToolUse:
    names = function_names(body)
    choice = choice_of(body.tool_choice, names)
    tools = tuple(tool.model_dump(exclude_none=True) for tool in body.tools or [])
    return ToolUse(tools, choice, body.parallel_tool_calls is not False)


def refuse_tools(route: Route, spec: BaseModelSpec, use: ToolUse) -> None:
    if not use.active:
        return
    held = held_by(route)
    if held is not None:
        message = f"{served_model(route)} answers with {held}, its contract, so it takes no tools."
        raise invalid("tools", message, "unsupported_value")
    if spec.tools is None:
        message = (
            f"{spec.key} has no tool-call format minibrain reads in its chat template; tools work with Qwen, "
            "Hermes, Llama 3.1 and later, Mistral and gpt-oss models."
        )
        raise invalid("tools", message, "unsupported_value")


def reasoning_of(body: ChatCompletionRequest, route: Route, spec: BaseModelSpec) -> str | None:
    effort = body.reasoning_effort
    if effort is None or (effort == NONE and spec.reasoning is None):
        return None
    held = held_by(route)
    if held is not None and effort != NONE:
        raise invalid(
            "reasoning_effort", f"{served_model(route)} answers with {held}, its contract, so it does not reason."
        )
    if effort in reasoning_choices(spec.reasoning):
        return effort
    if spec.reasoning == ALWAYS:
        message = f"{spec.key} always reasons and takes no effort; leave reasoning_effort unset."
    elif spec.reasoning == EFFORT:
        message = f"{spec.key} always reasons; set reasoning_effort to low, medium or high, or leave it unset."
    else:
        message = f"{spec.key} does not reason; leave reasoning_effort unset or none."
    raise invalid("reasoning_effort", message, "unsupported_value")


def checked_base(config: GatewayConfig, route: Route) -> tuple[BaseModelSpec, AdapterRef | None]:
    problem = config.problems.get(route.base_model)
    if problem is not None:
        raise HTTPException(status_code=503, detail=problem)
    base = spec_for(config, route.base_model)
    if not route.adapter:
        return base, None
    trained = route.adapter.get("base_hash")
    mismatch = base_changed(f"{route.slug}@{route.version}", route.base_model, trained, base.content_hash)
    if mismatch is not None:
        raise HTTPException(status_code=409, detail=mismatch)
    return base, AdapterRef(route.adapter["name"], route.adapter["artifact"], trained)


@dataclass(frozen=True)
class ChatPlan:
    route: Route
    request: CompletionRequest
    requested: Constraint | None
    conversation: list[dict[str, Any]] = field(default_factory=list)
    safety: SafetyPlan | None = None
    verdicts: list[Verdict] = field(default_factory=list)

    @property
    def verdict(self) -> Verdict | None:
        return self.verdicts[-1] if self.verdicts else None


def guard_spec(config: GatewayConfig, key: str) -> BaseModelSpec:
    found = config.guards.get(key) or config.bases.get(key)
    if found is None:
        raise HTTPException(status_code=503, detail=f"the safety model {key} is not on this install")
    return BaseModelSpec.from_dict(found)


def safety_of(body: Requested, route: Route, config: GatewayConfig) -> SafetyPlan | None:
    asked = body.safety
    configured = route.safety or {}
    model = configured.get("model")
    if model:
        if asked is not None and asked.model and asked.model != model:
            message = (
                f"{served_model(route)} is checked by the safety model {model}, set for it; a request cannot change "
                "or turn it off. Leave safety.model out."
            )
            raise invalid("safety.model", message, "unsupported_value")
        answers = bool(configured.get("answers")) or bool(asked and asked.answers)
        return SafetyPlan(guard_spec(config, str(model)), answers)
    if asked is None or not asked.model or asked.model == NONE:
        return None
    if asked.model not in config.guards:
        message = f"{asked.model} is not a safety model on this install."
        raise invalid("safety.model", message, "unsupported_value")
    return SafetyPlan(guard_spec(config, asked.model), bool(asked.answers))


def plan(
    body: ChatCompletionRequest,
    route: Route,
    base: BaseModelSpec,
    adapter: AdapterRef | None = None,
    safety: SafetyPlan | None = None,
) -> ChatPlan:
    refuse_unsupported(body)
    requested = narrowed(route, requested_format(body.response_format))
    use = tool_use_of(body)
    refuse_tools(route, base, use)
    conversation = plain(body.messages)
    request = CompletionRequest(
        base=base,
        messages=route_messages(route, conversation),
        adapter=adapter,
        max_tokens=body.token_budget,
        constraint=requested or task_constraint(route),
        route=route.name,
        sampling=sampling_of(body, route),
        tools=use,
        reasoning=reasoning_of(body, route, base),
    )
    return ChatPlan(route, request, requested, conversation, safety)


def complete(backend: ServingBackend, request: CompletionRequest, requested: bool) -> Completion:
    try:
        return backend.complete(request)
    except OutputFormatError as error:
        if requested or request.constraint is None:
            raise
        log.warning("answering %s without its label constraint: %s", request.base.key, error)
        return backend.complete(replace(request, constraint=None))


def completed(backend: ServingBackend, request: CompletionRequest, requested: bool) -> Completion:
    try:
        return complete(backend, request, requested)
    except EngineUnavailableError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except OutputFormatError as error:
        raise invalid(FORMAT, f"response_format cannot be applied: {error}.") from error
    except UnsupportedParameterError as error:
        raise invalid(error.param, f"{error.message}.", "unsupported_parameter") from error


def conformed(requested: Constraint | None, completion: Completion, route: Route | None = None) -> Completion:
    schema = requested.json_schema if requested else contract_schema(route) if route else None
    if schema is None or not completion.stopped or completion.tool_calls:
        return completion
    text = unfenced(completion.text)
    try:
        value = json.loads(text)
    except json.JSONDecodeError as error:
        message = f"The model's answer is not valid JSON ({error.msg}); {UNCONSTRAINED}"
        raise OpenAIError(422, message, FORMAT, "invalid_json", "invalid_output_error") from error
    problem = violation(schema, value)
    if problem is not None:
        against = "response_format" if requested else "the model's contract"
        message = f"The model's answer does not match {against}: {problem}; {UNCONSTRAINED}"
        raise OpenAIError(422, message, FORMAT, "schema_mismatch", "invalid_output_error")
    return replace(completion, text=text)


def checked(backend: ServingBackend, chat: ChatPlan, answer_text: str | None = None) -> Verdict | None:
    if chat.safety is None:
        return None
    try:
        verdict = judged(backend, chat.safety, chat.conversation, answer_text)
    except SafetyUnavailableError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    chat.verdicts.append(verdict)
    return verdict


def refused(verdict: Verdict, completion: Completion | None = None) -> Completion:
    tokens = (completion.prompt_tokens, completion.completion_tokens) if completion else (0, 0)
    seconds = completion.seconds if completion else 0.0
    return Completion("", tokens[0], tokens[1], True, seconds, refusal=verdict.refusal())


def prompt_refusal(backend: ServingBackend, chat: ChatPlan) -> Completion | None:
    verdict = checked(backend, chat)
    return refused(verdict) if verdict is not None and not verdict.safe else None


def answer(backend: ServingBackend, chat: ChatPlan) -> Completion:
    blocked = prompt_refusal(backend, chat)
    if blocked is not None:
        return blocked
    completion = conformed(chat.requested, completed(backend, chat.request, chat.requested is not None), chat.route)
    if chat.safety is None or not chat.safety.answers or not completion.text:
        return completion
    verdict = checked(backend, chat, completion.text)
    return refused(verdict, completion) if verdict is not None and not verdict.safe else completion


def run(
    backend: ServingBackend,
    config: GatewayConfig,
    route: Route,
    messages: list[dict[str, Any]],
    max_tokens: int | None,
) -> Completion:
    base, adapter = checked_base(config, route)
    request = CompletionRequest(
        base=base,
        messages=route_messages(route, messages),
        adapter=adapter,
        max_tokens=max_tokens,
        constraint=task_constraint(route),
        route=route.name,
        sampling=Sampling().or_greedy(),
    )
    return completed(backend, request, False)


def last_user_text(messages: list[Message]) -> str | None:
    texts = [text_of(message.content, "") for message in messages if message.role == "user"]
    found = [text for text in texts if text]
    return found[-1] if found else None


def response_id() -> str:
    return f"chatcmpl-{uuid.uuid4().hex}"


def usage(completion: Completion) -> dict[str, int]:
    return {
        "prompt_tokens": completion.prompt_tokens,
        "completion_tokens": completion.completion_tokens,
        "total_tokens": completion.prompt_tokens + completion.completion_tokens,
    }


def kept_output(completion: Completion) -> str:
    if completion.text or not completion.tool_calls:
        return completion.text
    return json.dumps([call.as_openai()["function"] for call in completion.tool_calls], ensure_ascii=False)


def answer_message(completion: Completion) -> dict[str, Any]:
    if completion.refusal:
        return {"role": "assistant", "content": None, "refusal": completion.refusal}
    content = completion.text if completion.text or not completion.tool_calls else None
    found: dict[str, Any] = {"role": "assistant", "content": content}
    if completion.reasoning:
        found["reasoning_content"] = completion.reasoning
    if completion.tool_calls:
        found["tool_calls"] = [call.as_openai() for call in completion.tool_calls]
    return found


def response_body(
    identifier: str, model: str, completion: Completion, verdict: Verdict | None = None
) -> dict[str, Any]:
    found = {
        "id": identifier,
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "message": answer_message(completion), "finish_reason": completion.finish_reason}],
        "usage": usage(completion),
    }
    return found | ({"safety": verdict.as_dict()} if verdict is not None else {})


def piece_of(completion: Completion) -> Piece:
    return Piece(content=completion.text, tool_calls=completion.tool_calls, reasoning=completion.reasoning or "")


def buffered(chat: ChatPlan) -> bool:
    checked_answers = chat.safety is not None and chat.safety.answers
    return checked_answers or chat.request.constraint is not None or contract_schema(chat.route) is not None


def mapped(events: Iterator[Event]) -> Iterator[Event]:
    try:
        yield from events
    except EngineUnavailableError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except OutputFormatError as error:
        raise invalid(FORMAT, f"response_format cannot be applied: {error}.") from error
    except UnsupportedParameterError as error:
        raise invalid(error.param, f"{error.message}.", "unsupported_parameter") from error


def chat_events(backend: ServingBackend, chat: ChatPlan) -> Iterator[Event]:
    stream = getattr(backend, "stream", None)
    blocked = prompt_refusal(backend, chat) if stream is not None and not buffered(chat) else None
    if blocked is not None:
        yield blocked
        return
    if stream is None or buffered(chat):
        completion = answer(backend, chat)
        if piece_of(completion):
            yield piece_of(completion)
        yield completion
        return
    yield from mapped(stream(chat.request))


def data(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def delta_of(piece: Piece, first_call: int, opening: bool) -> dict[str, Any]:
    found: dict[str, Any] = {"role": "assistant"} if opening else {}
    if piece.refusal:
        found["refusal"] = piece.refusal
    if piece.reasoning:
        found["reasoning_content"] = piece.reasoning
    if piece.content or opening:
        found["content"] = piece.content
    if piece.tool_calls:
        calls = enumerate(piece.tool_calls, start=first_call)
        found["tool_calls"] = [{"index": index} | call.as_openai() for index, call in calls]
    return found


def moving(delta: dict[str, Any]) -> dict[str, Any]:
    return {"index": 0, "delta": delta, "finish_reason": None}


def failure_body(error: BaseException) -> dict[str, Any]:
    if isinstance(error, OpenAIError):
        return error.body()
    if isinstance(error, HTTPException):
        return OpenAIError(error.status_code, str(error.detail), kind="server_error").body()
    return OpenAIError(500, str(error) or type(error).__name__, kind="server_error").body()


Finished = Callable[[Completion | None, BaseException | None], None]


class Chunks(Protocol):
    def piece(self, piece: Piece) -> dict[str, Any] | None: ...

    def ending(self, final: Completion) -> list[dict[str, Any]]: ...


def usage_endings(last: dict[str, Any], final: Completion, include_usage: bool) -> list[dict[str, Any]]:
    if include_usage:
        return [{"choices": [last]}, {"choices": [], "usage": usage(final)}]
    return [{"choices": [last], "usage": usage(final)}]


@dataclass
class ChatChunks:
    include_usage: bool = False
    calls: int = 0
    opening: bool = True

    def piece(self, piece: Piece) -> dict[str, Any] | None:
        found = {"choices": [moving(delta_of(piece, self.calls, self.opening))]}
        self.calls, self.opening = self.calls + len(piece.tool_calls), False
        return found

    def ending(self, final: Completion) -> list[dict[str, Any]]:
        found: list[dict[str, Any]] = []
        if self.opening or final.refusal:
            found.append({"choices": [moving(delta_of(Piece(refusal=final.refusal or ""), 0, self.opening))]})
        last = {"index": 0, "delta": {}, "finish_reason": final.finish_reason}
        return found + usage_endings(last, final, self.include_usage)


def events_sse(
    head: dict[str, Any], first: Event, events: Iterator[Event], chunks: Chunks, finished: Finished | None = None
) -> Iterator[str]:
    final: Completion | None = None
    failure: BaseException | None = None
    try:
        for event in itertools.chain([first], events):
            if isinstance(event, Completion):
                final = event
                continue
            found = chunks.piece(event)
            if found is not None:
                yield data(head | found)
        if final is None:
            raise EngineUnavailableError("the engine stopped before it finished the answer")
        for found in chunks.ending(final):
            yield data(head | found)
    except Exception as error:
        failure = error
        log.warning("a streamed answer failed: %s", error)
        yield data(failure_body(error))
    finally:
        if finished is not None:
            finished(final, failure)
    yield "data: [DONE]\n\n"


def sse(
    identifier: str,
    model: str,
    first: Event,
    events: Iterator[Event],
    include_usage: bool = False,
    finished: Finished | None = None,
) -> Iterator[str]:
    head = {"id": identifier, "object": "chat.completion.chunk", "created": int(time.time()), "model": model}
    return events_sse(head, first, events, ChatChunks(include_usage), finished)
