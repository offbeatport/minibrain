import contextlib
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

from minibrain.data.feedback import ORIGIN_API, Submission
from minibrain.gateway.chat import (
    ChatPlan,
    Requested,
    answer,
    chat_events,
    checked_base,
    kept_output,
    last_user_text,
    plan,
    response_body,
    response_id,
    safety_of,
    served_model,
    sse,
)
from minibrain.gateway.config import ConfigSource, GatewayConfig, Grant, Route
from minibrain.gateway.errors import OpenAIError
from minibrain.gateway.logs import CHAT_KIND, COMPLETION_KIND, LogBuffer, LogEntry
from minibrain.gateway.safety import Verdict
from minibrain.gateway.schema import (
    CHAT_HELP,
    CHAT_RESPONSES,
    FEEDBACK_RESPONSES,
    KEY_ERRORS,
    TEXT_HELP,
    TEXT_RESPONSES,
    ChatCompletionRequest,
    ModelInfo,
    ModelList,
    TextCompletionRequest,
)
from minibrain.gateway.text import kept_prompt, text_body, text_id, text_plan, text_sse
from minibrain.ml.completion import Completion
from minibrain.registry.models import now
from minibrain.registry.service import KEY_PREFIX, key_digest
from minibrain.telemetry.call import current_call

router = APIRouter(prefix="/v1")

TEXT_MAX = 50_000
CLIENT_CLOSED = 499
COMMENT_MAX = 2_000
API_KEY = HTTPBearer(
    auto_error=False,
    scheme_name="apiKey",
    bearerFormat="mb_...",
    description="A minibrain API key, created on the API keys page. It covers one or more models, or all models.",
)

FeedbackSink = Callable[[Submission], int]


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


@dataclass(frozen=True)
class Surface:
    kind: str
    operation: str
    identifier: Callable[[], str]
    plan: Callable[..., ChatPlan]
    body: Callable[[str, str, Completion, Verdict | None], dict[str, Any]]
    stream: Callable[..., Iterator[str]]
    input: Callable[[Any], str | None]


CHAT = Surface(CHAT_KIND, "chat", response_id, plan, response_body, sse, lambda body: last_user_text(body.messages))
TEXT = Surface(
    COMPLETION_KIND,
    "text_completion",
    text_id,
    text_plan,
    text_body,
    text_sse,
    lambda body: kept_prompt(body.prompt),
)


def sampling_labels(body: Requested) -> dict[str, Any]:
    stops = [body.stop] if isinstance(body.stop, str) else body.stop
    found = {
        "temperature": body.temperature,
        "top_p": body.top_p,
        "top_k": body.top_k,
        "presence_penalty": body.presence_penalty,
        "frequency_penalty": body.frequency_penalty,
        "seed": body.seed,
        "stop_sequences": stops or None,
    }
    return {name: value for name, value in found.items() if value is not None}


def note_call(
    surface: Surface,
    body: Requested,
    route: Route | None,
    completion: Completion | None,
    answered: str | None,
    code: str | None,
) -> None:
    call = current_call()
    if call is None:
        return
    call.operation = surface.operation
    call.request_model = body.model
    call.model_known = route is not None
    call.max_tokens = body.token_budget
    call.labels |= {f"gen_ai.request.{name}": value for name, value in sampling_labels(body).items()}
    call.response_id = answered
    call.error_type = code
    if route is not None:
        call.response_model = served_model(route)
        call.labels |= {"minibrain.model.slug": route.slug, "minibrain.model.version": route.version}
    if completion is not None:
        call.input_tokens = completion.prompt_tokens
        call.output_tokens = completion.completion_tokens
        call.finish_reasons = (completion.finish_reason,)


@router.get(
    "/models",
    tags=["models"],
    summary="List models",
    description="The models this API key can call, each version under its own name.",
    responses=KEY_ERRORS,
)
def list_models(grant: GrantDep, config: ConfigDep) -> ModelList:
    names = grant.reachable(config.models)
    return ModelList(data=[ModelInfo(id=name, created=0, owned_by="minibrain") for name in names])


def undeployed(config: GatewayConfig, grant: Grant, name: str) -> str | None:
    numbers = [
        route.version
        for route in config.routes.values()
        if route.slug == name and route.version is not None and route.name != name and grant.covers(route)
    ]
    if not numbers:
        return None
    return f"{name} is not deployed; deploy it, or call one of its versions such as {name}@{max(numbers)}"


def missing(config: GatewayConfig, grant: Grant, name: str) -> OpenAIError:
    message = config.deleted.get(name.partition("@")[0]) or undeployed(config, grant, name)
    return OpenAIError(404, message or f"model {name} not found", "model", "model_not_found")


def routed(config: GatewayConfig, grant: Grant, model: str) -> Route:
    route = config.routes.get(model)
    if route is None:
        raise missing(config, grant, model)
    if not grant.covers(route):
        raise HTTPException(status_code=403, detail=f"this API key does not cover {model}")
    return route


def served(
    surface: Surface, body: Requested, grant: Grant, config: GatewayConfig, request: Request
) -> dict | StreamingResponse:
    started = time.monotonic()
    identifier = surface.identifier()
    route = config.routes.get(body.model)
    planned: list[ChatPlan] = []

    def finished(completion: Completion | None, error: BaseException | None) -> None:
        verdict = planned[0].verdict if planned else None
        outcome = Outcome(completion, error, verdict)
        log_call(request.app.state.request_logs, surface, body, grant, route, identifier, started, outcome)

    try:
        route = routed(config, grant, body.model)
        base, adapter = checked_base(config, route)
        chat = surface.plan(body, route, base, adapter, safety_of(body, route, config))
        planned.append(chat)
        backend = request.app.state.backend
        if body.stream:
            events = chat_events(backend, chat)
            stream = surface.stream(identifier, body.model, next(events), events, include_usage(body), finished)
            return StreamingResponse(stream, media_type="text/event-stream")
        completion = answer(backend, chat)
    except Exception as error:
        finished(None, error)
        raise
    finished(completion, None)
    return surface.body(identifier, body.model, completion, chat.verdict)


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
    return served(CHAT, body, grant, config, request)


@router.post(
    "/completions",
    response_model=None,
    tags=["completions"],
    summary="Create a text completion",
    description=TEXT_HELP,
    responses=TEXT_RESPONSES,
)
def completions(
    body: TextCompletionRequest, grant: GrantDep, config: ConfigDep, request: Request
) -> dict | StreamingResponse:
    return served(TEXT, body, grant, config, request)


def include_usage(body: Requested) -> bool:
    options = (body.model_extra or {}).get("stream_options")
    return isinstance(options, dict) and bool(options.get("include_usage"))


def status_of(error: BaseException | None) -> int:
    if error is None:
        return 200
    return error.status_code if isinstance(error, HTTPException | OpenAIError) else 500


@dataclass(frozen=True)
class Outcome:
    completion: Completion | None
    error: BaseException | None
    verdict: Verdict | None = None

    @property
    def blocked(self) -> dict[str, Any] | None:
        return self.verdict.as_dict() if self.verdict is not None and not self.verdict.safe else None


def log_call(
    logs: LogBuffer,
    surface: Surface,
    body: Requested,
    grant: Grant,
    route: Route | None,
    identifier: str,
    started: float,
    outcome: Outcome,
) -> None:
    completion, error = outcome.completion, outcome.error
    status = status_of(error) if completion is not None or error is not None else CLIENT_CLOSED
    answered = completion is not None and status == 200
    kept = answered and route is not None and route.request_bodies
    code = error.code if isinstance(error, OpenAIError) else None
    note_call(surface, body, route, completion if answered else None, identifier if answered else None, code)
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
            input=surface.input(body) if kept else None,
            output=kept_output(completion) if completion and kept else None,
            finish_reason=completion.finish_reason if completion and answered else None,
            safety=outcome.blocked,
            kind=surface.kind,
        )
    )


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
    route = routed(config, grant, body.model)
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
