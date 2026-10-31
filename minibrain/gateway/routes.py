import json
import time
import uuid
from collections.abc import Iterator
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict

from minibrain.base_models import BaseModelSpec, base_model
from minibrain.data.snapshot import Example
from minibrain.gateway.config import ConfigSource, GatewayConfig, Grant, Route
from minibrain.gateway.logs import LogBuffer, LogEntry
from minibrain.ml.completion import Completion
from minibrain.registry.models import now
from minibrain.registry.service import KEY_PREFIX, key_digest
from minibrain.serve.backend import AdapterRef, CompletionRequest, EngineUnavailableError, ServingBackend
from minibrain.tasks.classify import build_messages

router = APIRouter(prefix="/v1", tags=["openai"])

DEFAULT_MAX_TOKENS = 64


class Message(BaseModel):
    model_config = ConfigDict(extra="allow")

    role: str
    content: str | None = None


class ChatCompletionRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    model: str
    messages: list[Message]
    max_tokens: int | None = None
    max_completion_tokens: int | None = None
    stream: bool = False


def gateway_config(request: Request) -> GatewayConfig:
    source: ConfigSource = request.app.state.gateway_config
    return source.current()


ConfigDep = Annotated[GatewayConfig, Depends(gateway_config)]


def authorize(request: Request, config: ConfigDep) -> Grant:
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    token = token.strip()
    grant = config.keys.get(key_digest(token)) if scheme.lower() == "bearer" and token.startswith(KEY_PREFIX) else None
    if grant is None:
        raise HTTPException(status_code=401, detail="invalid API key")
    return grant


GrantDep = Annotated[Grant, Depends(authorize)]


def spec_for(config: GatewayConfig, key: str) -> BaseModelSpec:
    found = config.bases.get(key)
    return BaseModelSpec.from_dict(found) if found else base_model(key)


def route_messages(route: Route, messages: list[dict[str, str]]) -> list[dict[str, str]]:
    if route.kind == "base":
        return messages
    texts = [message["content"] for message in messages if message.get("role") == "user" and message.get("content")]
    if not texts:
        raise HTTPException(status_code=400, detail="a user message with text content is required")
    shots = [Example(input=shot_input, label=label) for shot_input, label in route.shots]
    return build_messages(route.kind, texts[-1], route.labels, shots)


def completion_request(
    config: GatewayConfig, route: Route, messages: list[dict[str, str]], max_tokens: int
) -> CompletionRequest:
    adapter = AdapterRef(route.adapter["name"], route.adapter["artifact"]) if route.adapter else None
    return CompletionRequest(
        base=spec_for(config, route.base_model),
        messages=route_messages(route, messages),
        adapter=adapter,
        max_tokens=max_tokens,
    )


def run(
    backend: ServingBackend, config: GatewayConfig, route: Route, messages: list[dict[str, str]], max_tokens: int
) -> Completion:
    try:
        return backend.complete(completion_request(config, route, messages, max_tokens))
    except EngineUnavailableError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


def plain(messages: list[Message]) -> list[dict[str, str]]:
    return [{"role": message.role, "content": message.content or ""} for message in messages]


def usage(completion: Completion) -> dict[str, int]:
    return {
        "prompt_tokens": completion.prompt_tokens,
        "completion_tokens": completion.completion_tokens,
        "total_tokens": completion.prompt_tokens + completion.completion_tokens,
    }


def finish_reason(completion: Completion) -> str:
    return "stop" if completion.stopped else "length"


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


@router.get("/models")
def list_models(grant: GrantDep, config: ConfigDep) -> dict:
    names = config.models.get(grant.owner, [])
    data = [{"id": name, "object": "model", "created": 0, "owned_by": "minibrain"} for name in names]
    return {"object": "list", "data": data}


@router.post("/chat/completions", response_model=None)
def chat_completions(
    body: ChatCompletionRequest, grant: GrantDep, config: ConfigDep, request: Request
) -> dict | StreamingResponse:
    started = time.monotonic()
    logs: LogBuffer = request.app.state.request_logs
    route = config.routes.get(body.model)
    status = 200
    completion: Completion | None = None
    try:
        if route is None or route.owner != grant.owner:
            raise HTTPException(status_code=404, detail=f"model {body.model} not found")
        max_tokens = body.max_completion_tokens or body.max_tokens or DEFAULT_MAX_TOKENS
        completion = run(request.app.state.backend, config, route, plain(body.messages), max_tokens)
    except HTTPException as error:
        status = error.status_code
        raise
    finally:
        logs.add(
            LogEntry(
                at=now(),
                key_id=grant.key_id,
                minibrain_id=grant.minibrain_id,
                model=body.model,
                version=route.version if route else None,
                status=status,
                latency_ms=(time.monotonic() - started) * 1000,
                prompt_tokens=completion.prompt_tokens if completion else 0,
                completion_tokens=completion.completion_tokens if completion else 0,
            )
        )
    if completion is None:
        raise HTTPException(status_code=500, detail="no completion")
    identifier = f"chatcmpl-{uuid.uuid4().hex}"
    if body.stream:
        return StreamingResponse(stream_events(identifier, body.model, completion), media_type="text/event-stream")
    return response_body(identifier, body.model, completion)
