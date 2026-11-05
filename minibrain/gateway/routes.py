import contextlib
import json
import logging
import re
import time
import uuid
from collections.abc import Callable, Iterator
from dataclasses import replace
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field

from minibrain.base_models import BaseModelSpec, base_model
from minibrain.data.feedback import ORIGIN_API, Submission
from minibrain.gateway.config import ConfigSource, GatewayConfig, Grant, Route
from minibrain.gateway.logs import LogBuffer, LogEntry
from minibrain.ml.completion import Completion
from minibrain.models.health import base_changed
from minibrain.registry.models import now
from minibrain.registry.service import KEY_PREFIX, key_digest
from minibrain.serve.backend import (
    AdapterRef,
    CompletionRequest,
    EngineUnavailableError,
    OutputFormatError,
    ServingBackend,
)
from minibrain.serve.structured import JSON_OBJECT, Constraint, schema_problem, unfenced, violation
from minibrain.tasks.contracts import JSON, Contract
from minibrain.tasks.prompting import PromptError, Prompting
from minibrain.telemetry.call import current_call

router = APIRouter(prefix="/v1")
log = logging.getLogger("minibrain.gateway")

DEFAULT_MAX_TOKENS = 64
TEXT_MAX = 50_000
COMMENT_MAX = 2_000
FORMAT = "response_format"
SCHEMA_FORMAT = f"{FORMAT}.json_schema"
FORMAT_NAME = re.compile(r"[A-Za-z0-9_-]{1,64}")
UNCONSTRAINED = "only SGLang and llama.cpp engines constrain decoding, the others check the answer afterwards."
FORMAT_HELP = (
    'An OpenAI response_format: {"type": "text"}, {"type": "json_object"} or '
    '{"type": "json_schema", "json_schema": {"name": ..., "schema": {...}, "strict": true}}.'
)

MODEL_HELP = (
    "A name from GET /models: a custom model follows its live version, name@3 pins version 3, "
    "and a served base model goes by its key."
)
CHAT_HELP = (
    "Answer a conversation with a model. Every call is logged without its content, "
    "unless the model keeps request inputs and answers."
)
MESSAGES_HELP = "The conversation. A custom model answers the last user message; a base model reads them all."
API_KEY = HTTPBearer(
    auto_error=False,
    scheme_name="apiKey",
    bearerFormat="mb_...",
    description="A minibrain API key, created on Deployments. It covers one or more models.",
)

FeedbackSink = Callable[[Submission], int]


class OpenAIError(Exception):
    def __init__(
        self, status_code: int, message: str, param: str | None = None, code: str | None = None, kind: str = ""
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.message = message
        self.param = param
        self.code = code
        self.kind = kind or "invalid_request_error"

    def body(self) -> dict[str, Any]:
        return {"error": {"message": self.message, "type": self.kind, "param": self.param, "code": self.code}}


async def openai_error(_request: Request, error: Exception) -> JSONResponse:
    found = error if isinstance(error, OpenAIError) else OpenAIError(500, str(error), kind="server_error")
    return JSONResponse(status_code=found.status_code, content=found.body())


def invalid(param: str, message: str, code: str = "invalid_value") -> OpenAIError:
    return OpenAIError(400, message, param, code)


class Message(BaseModel):
    model_config = ConfigDict(extra="allow")

    role: str = Field(description="system, user or assistant.")
    content: str | None = None


class ChatCompletionRequest(BaseModel):
    model_config = ConfigDict(
        extra="allow",
        json_schema_extra={
            "example": {"model": "support-triage", "messages": [{"role": "user", "content": "I was charged twice"}]}
        },
    )

    model: str = Field(description=MODEL_HELP)
    messages: list[Message] = Field(description=MESSAGES_HELP)
    max_tokens: int | None = Field(
        default=None, description=f"The most tokens to answer with; {DEFAULT_MAX_TOKENS} by default."
    )
    max_completion_tokens: int | None = Field(default=None, description="The same as max_tokens, under its newer name.")
    stream: bool = Field(default=False, description="Send the answer as server-sent events, ending with data: [DONE].")
    response_format: Any = Field(default=None, description=FORMAT_HELP)


class ModelInfo(BaseModel):
    id: str = Field(description="The name to send as model.")
    object: Literal["model"] = "model"
    created: int
    owned_by: str


class ModelList(BaseModel):
    object: Literal["list"] = "list"
    data: list[ModelInfo]


class AnswerMessage(BaseModel):
    role: Literal["assistant"]
    content: str


class CompletionChoice(BaseModel):
    index: int
    message: AnswerMessage
    finish_reason: Literal["stop", "length"] = Field(
        description="stop when the answer ended, length when max_tokens cut it."
    )


class TokenUsage(BaseModel):
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int


class ChatCompletion(BaseModel):
    id: str = Field(description="The response id; send it as response_id to POST /feedback.")
    object: Literal["chat.completion"]
    created: int
    model: str
    choices: list[CompletionChoice]
    usage: TokenUsage


class ErrorInfo(BaseModel):
    message: str
    type: str
    param: str | None
    code: str | None


class OpenAIErrorBody(BaseModel):
    error: ErrorInfo


class ErrorDetail(BaseModel):
    detail: str


KEY_ERRORS: dict[int | str, dict[str, Any]] = {
    401: {"model": ErrorDetail, "description": "The API key is missing, unknown or expired."},
}
MODEL_ERRORS: dict[int | str, dict[str, Any]] = {
    **KEY_ERRORS,
    403: {"model": ErrorDetail, "description": "The API key does not cover this model."},
    404: {"model": ErrorDetail, "description": "No model has this name."},
}
CHAT_RESPONSES: dict[int | str, dict[str, Any]] = {
    200: {
        "model": ChatCompletion,
        "description": "The answer, or with stream set, server-sent chat.completion.chunk events.",
        "content": {"text/event-stream": {"schema": {"type": "string"}}},
    },
    400: {"model": OpenAIErrorBody, "description": "response_format is not valid or cannot be applied."},
    **MODEL_ERRORS,
    409: {"model": ErrorDetail, "description": "The version was trained on base weights that have changed since."},
    422: {
        "model": OpenAIErrorBody,
        "description": "The answer does not match response_format, or the body is not valid.",
    },
    503: {"model": ErrorDetail, "description": "No engine is serving this model right now."},
}
FEEDBACK_RESPONSES: dict[int | str, dict[str, Any]] = {
    **MODEL_ERRORS,
    422: {"model": ErrorDetail, "description": "The model is a base model, or the body is not valid."},
}


def gateway_config(request: Request) -> GatewayConfig:
    source: ConfigSource = request.app.state.gateway_config
    return source.current()


ConfigDep = Annotated[GatewayConfig, Depends(gateway_config)]


def authorize(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(API_KEY)], config: ConfigDep
) -> Grant:
    token = credentials.credentials.strip() if credentials else ""
    grant = config.keys.get(key_digest(token)) if token.startswith(KEY_PREFIX) else None
    if grant is None:
        raise HTTPException(status_code=401, detail="invalid API key")
    if grant.expired(now()):
        raise HTTPException(status_code=401, detail="API key expired")
    call = current_call()
    if call is not None:
        call.labels["minibrain.api_key.id"] = grant.key_id
    return grant


GrantDep = Annotated[Grant, Depends(authorize)]


def spec_for(config: GatewayConfig, key: str) -> BaseModelSpec:
    found = config.bases.get(key)
    return BaseModelSpec.from_dict(found) if found else base_model(key)


def prompting(route: Route) -> Prompting | None:
    return Prompting.from_dict(route.prompting) if route.kind != "base" and route.prompting else None


def route_messages(route: Route, messages: list[dict[str, str]]) -> list[dict[str, str]]:
    found = prompting(route)
    if found is None:
        return messages
    try:
        return found.messages(messages)
    except PromptError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


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


def conformed(requested: Constraint | None, completion: Completion, route: Route | None = None) -> Completion:
    schema = requested.json_schema if requested else contract_schema(route) if route else None
    if schema is None or not completion.stopped:
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


def completion_request(
    config: GatewayConfig,
    route: Route,
    messages: list[dict[str, str]],
    max_tokens: int,
    constraint: Constraint | None = None,
) -> CompletionRequest:
    problem = config.problems.get(route.base_model)
    if problem is not None:
        raise HTTPException(status_code=503, detail=problem)
    base = spec_for(config, route.base_model)
    adapter = None
    if route.adapter:
        trained = route.adapter.get("base_hash")
        mismatch = base_changed(f"{route.slug}@{route.version}", route.base_model, trained, base.content_hash)
        if mismatch is not None:
            raise HTTPException(status_code=409, detail=mismatch)
        adapter = AdapterRef(route.adapter["name"], route.adapter["artifact"], trained)
    return CompletionRequest(
        base=base,
        messages=route_messages(route, messages),
        adapter=adapter,
        max_tokens=max_tokens,
        constraint=constraint,
        route=route.name,
    )


def complete(backend: ServingBackend, request: CompletionRequest, requested: bool) -> Completion:
    try:
        return backend.complete(request)
    except OutputFormatError as error:
        if requested or request.constraint is None:
            raise
        log.warning("answering %s without its label constraint: %s", request.base.key, error)
        return backend.complete(replace(request, constraint=None))


def run(
    backend: ServingBackend,
    config: GatewayConfig,
    route: Route,
    messages: list[dict[str, str]],
    max_tokens: int,
    requested: Constraint | None = None,
) -> Completion:
    constraint = requested or task_constraint(route)
    try:
        return complete(backend, completion_request(config, route, messages, max_tokens, constraint), bool(requested))
    except EngineUnavailableError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except OutputFormatError as error:
        raise invalid(FORMAT, f"response_format cannot be applied: {error}.") from error


def plain(messages: list[Message]) -> list[dict[str, str]]:
    return [{"role": message.role, "content": message.content or ""} for message in messages]


def last_user_text(messages: list[Message]) -> str | None:
    texts = [message.content for message in messages if message.role == "user" and message.content]
    return texts[-1] if texts else None


def response_id() -> str:
    return f"chatcmpl-{uuid.uuid4().hex}"


def usage(completion: Completion) -> dict[str, int]:
    return {
        "prompt_tokens": completion.prompt_tokens,
        "completion_tokens": completion.completion_tokens,
        "total_tokens": completion.prompt_tokens + completion.completion_tokens,
    }


def finish_reason(completion: Completion) -> str:
    return "stop" if completion.stopped else "length"


def served_model(route: Route) -> str:
    return route.slug if route.version is None else f"{route.slug}@{route.version}"


def note_chat(
    body: ChatCompletionRequest,
    route: Route | None,
    completion: Completion | None,
    answered: str | None,
    code: str | None,
) -> None:
    call = current_call()
    if call is None:
        return
    call.operation = "chat"
    call.request_model = body.model
    call.model_known = route is not None
    call.max_tokens = body.max_completion_tokens or body.max_tokens or DEFAULT_MAX_TOKENS
    call.response_id = answered
    call.error_type = code
    if route is not None:
        call.response_model = served_model(route)
        call.labels |= {"minibrain.model.slug": route.slug, "minibrain.model.version": route.version}
    if completion is not None:
        call.input_tokens = completion.prompt_tokens
        call.output_tokens = completion.completion_tokens
        call.finish_reasons = (finish_reason(completion),)


def response_body(identifier: str, model: str, completion: Completion) -> dict:
    return {
        "id": identifier,
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": completion.text},
                "finish_reason": finish_reason(completion),
            }
        ],
        "usage": usage(completion),
    }


def stream_events(identifier: str, model: str, completion: Completion) -> Iterator[str]:
    created = int(time.time())
    chunk = {"id": identifier, "object": "chat.completion.chunk", "created": created, "model": model}
    first = {"index": 0, "delta": {"role": "assistant", "content": completion.text}, "finish_reason": None}
    last = {"index": 0, "delta": {}, "finish_reason": finish_reason(completion)}
    yield f"data: {json.dumps(chunk | {'choices': [first]})}\n\n"
    yield f"data: {json.dumps(chunk | {'choices': [last], 'usage': usage(completion)})}\n\n"
    yield "data: [DONE]\n\n"


@router.get(
    "/models",
    tags=["models"],
    summary="List models",
    description="The models this API key can call, each version under its own name.",
    responses=KEY_ERRORS,
)
def list_models(grant: GrantDep, config: ConfigDep) -> ModelList:
    names = [name for owner in grant.owners for name in config.models.get(owner, [])]
    return ModelList(data=[ModelInfo(id=name, created=0, owned_by="minibrain") for name in names])


@router.post(
    "/chat/completions",
    response_model=None,
    tags=["chat"],
    summary="Create a chat completion",
    description=CHAT_HELP,
    responses=CHAT_RESPONSES,
)
def chat_completions(
    body: ChatCompletionRequest, grant: GrantDep, config: ConfigDep, request: Request
) -> dict | StreamingResponse:
    started = time.monotonic()
    logs: LogBuffer = request.app.state.request_logs
    identifier = response_id()
    route = config.routes.get(body.model)
    status = 200
    code: str | None = None
    completion: Completion | None = None
    try:
        if route is None:
            raise HTTPException(status_code=404, detail=f"model {body.model} not found")
        if not grant.covers(route):
            raise HTTPException(status_code=403, detail=f"this API key does not cover {body.model}")
        requested = requested_format(body.response_format)
        max_tokens = body.max_completion_tokens or body.max_tokens or DEFAULT_MAX_TOKENS
        completion = run(request.app.state.backend, config, route, plain(body.messages), max_tokens, requested)
        completion = conformed(requested, completion, route)
    except (HTTPException, OpenAIError) as error:
        status = error.status_code
        code = error.code if isinstance(error, OpenAIError) else None
        raise
    finally:
        answered = completion is not None and status == 200
        kept = answered and route is not None and route.request_bodies
        note_chat(body, route, completion, identifier if answered else None, code)
        logs.add(
            LogEntry(
                at=now(),
                key_id=grant.key_id,
                model_id=route.model_id if route else None,
                model=body.model,
                version=route.version if route else None,
                contract=route.contract if route else None,
                status=status,
                latency_ms=(time.monotonic() - started) * 1000,
                prompt_tokens=completion.prompt_tokens if completion else 0,
                completion_tokens=completion.completion_tokens if completion else 0,
                response_id=identifier if answered else None,
                input=last_user_text(body.messages) if kept else None,
                output=completion.text if completion and kept else None,
                finish_reason=finish_reason(completion) if completion and answered else None,
            )
        )
    if completion is None:
        raise HTTPException(status_code=500, detail="no completion")
    if body.stream:
        return StreamingResponse(stream_events(identifier, body.model, completion), media_type="text/event-stream")
    return response_body(identifier, body.model, completion)


class FeedbackRequest(BaseModel):
    model: str = Field(description="The model name the completion was requested from, such as support-triage.")
    response_id: str = Field(
        min_length=1, max_length=200, description="The id of the chat completion, as the gateway returned it."
    )
    rating: Literal["up", "down"] = Field(description="up when the answer was right, down when it was wrong.")
    correction: str | None = Field(
        default=None, max_length=TEXT_MAX, description="The right answer, when the rating is down and it is known."
    )
    comment: str | None = Field(default=None, max_length=COMMENT_MAX, description="A note for the reviewer.")
    input: str | None = Field(
        default=None,
        max_length=TEXT_MAX,
        description="The user message the model answered. Required unless the model keeps request inputs and answers.",
    )
    output: str | None = Field(
        default=None, max_length=TEXT_MAX, description="The answer the app received, when the model does not keep it."
    )


class FeedbackReceipt(BaseModel):
    id: int
    object: Literal["feedback"] = "feedback"
    status: Literal["pending"] = "pending"


@router.post(
    "/feedback",
    status_code=201,
    tags=["feedback"],
    summary="Rate or correct a chat completion",
    description="The feedback waits in the review queue; accepted answers join the model's next training data.",
    responses=FEEDBACK_RESPONSES,
)
def feedback(body: FeedbackRequest, grant: GrantDep, config: ConfigDep, request: Request) -> FeedbackReceipt:
    route = config.routes.get(body.model)
    if route is None:
        raise HTTPException(status_code=404, detail=f"model {body.model} not found")
    if not grant.covers(route):
        raise HTTPException(status_code=403, detail=f"this API key does not cover {body.model}")
    if route.model_id is None:
        raise HTTPException(status_code=422, detail="feedback is collected for custom models only")
    logs: LogBuffer = request.app.state.request_logs
    with contextlib.suppress(Exception):
        logs.flush()
    sink: FeedbackSink = request.app.state.feedback
    submission = Submission(
        model_id=route.model_id,
        origin=ORIGIN_API,
        rating=body.rating,
        response_id=body.response_id,
        version=route.version,
        key_id=grant.key_id,
        input=body.input,
        output=body.output,
        correction=body.correction,
        comment=body.comment,
    )
    return FeedbackReceipt(id=sink(submission))
