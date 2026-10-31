import json
import time
import uuid
from collections.abc import Iterator
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict

from minibrain.api.deps import BackendDep, SessionDep, StoreDep
from minibrain.ml.completion import Completion
from minibrain.registry.models import ApiKey, now
from minibrain.registry.service import find_key
from minibrain.serve.resolve import completion_request, model_names, resolve

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


def authorize(request: Request, session: SessionDep) -> ApiKey:
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    key = find_key(session, token.strip()) if scheme.lower() == "bearer" else None
    if key is None:
        raise HTTPException(status_code=401, detail="invalid API key")
    return key


KeyDep = Annotated[ApiKey, Depends(authorize)]


def last_user_text(messages: list[Message]) -> str:
    texts = [message.content for message in messages if message.role == "user" and message.content]
    if not texts:
        raise HTTPException(status_code=400, detail="a user message with text content is required")
    return texts[-1]


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
def list_models(key: KeyDep) -> dict:
    names = model_names(key.minibrain)
    data = [{"id": name, "object": "model", "created": 0, "owned_by": "minibrain"} for name in names]
    return {"object": "list", "data": data}


@router.post("/chat/completions", response_model=None)
def chat_completions(
    body: ChatCompletionRequest, key: KeyDep, session: SessionDep, backend: BackendDep, store: StoreDep
) -> dict | StreamingResponse:
    target = resolve(session, body.model)
    if target is None or target.minibrain.id != key.minibrain_id:
        raise HTTPException(status_code=404, detail=f"model {body.model} not found")
    max_tokens = body.max_completion_tokens or body.max_tokens or DEFAULT_MAX_TOKENS
    completion = backend.complete(completion_request(session, store, target, last_user_text(body.messages), max_tokens))
    key.last_used_at = now()
    session.commit()
    identifier = f"chatcmpl-{uuid.uuid4().hex}"
    if body.stream:
        return StreamingResponse(stream_events(identifier, body.model, completion), media_type="text/event-stream")
    return response_body(identifier, body.model, completion)
