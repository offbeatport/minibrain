import threading
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from spikes.banking77.inference import Completion, Runtime, generate, load_runtime
from spikes.banking77.prompts import Message, render_prompt
from spikes.banking77.versions import MINIBRAIN, Version, adapter_paths, load_versions, resolve

BASE_NAME = "qwen3-0.6b"


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    model: str
    messages: list[ChatMessage]
    max_tokens: int = 64


@dataclass(frozen=True)
class Server:
    runtime: Runtime
    versions: dict[str, Version]
    lock: threading.Lock


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    versions = load_versions()
    runtime = load_runtime(adapter_paths(list(versions.values())))
    app.state.server = Server(runtime=runtime, versions=versions, lock=threading.Lock())
    yield


app = FastAPI(lifespan=lifespan)


def last_user_text(messages: list[Message]) -> str:
    texts = [message["content"] for message in messages if message["role"] == "user"]
    if not texts:
        raise HTTPException(status_code=400, detail="a user message is required")
    return texts[-1]


def route(request: ChatRequest, versions: dict[str, Version]) -> tuple[list[Message], str | None]:
    messages = [message.model_dump() for message in request.messages]
    if request.model == BASE_NAME:
        return messages, None
    version = resolve(request.model, versions)
    if version is None:
        raise HTTPException(status_code=404, detail=f"unknown model {request.model}")
    return version.build_messages(last_user_text(messages)), version.adapter


def completion_response(model: str, completion: Completion) -> dict:
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": completion.text},
                "finish_reason": "stop" if completion.stopped else "length",
            }
        ],
        "usage": {
            "prompt_tokens": completion.prompt_tokens,
            "completion_tokens": completion.completion_tokens,
            "total_tokens": completion.prompt_tokens + completion.completion_tokens,
        },
    }


@app.get("/v1/models")
def list_models() -> dict:
    server: Server = app.state.server
    names = [BASE_NAME, MINIBRAIN, *server.versions]
    return {"object": "list", "data": [{"id": name, "object": "model", "owned_by": "minibrain"} for name in names]}


@app.post("/v1/chat/completions")
def chat_completions(request: ChatRequest) -> dict:
    server: Server = app.state.server
    messages, adapter = route(request, server.versions)
    prompt = render_prompt(server.runtime.tokenizer, messages)
    with server.lock:
        completion = generate(server.runtime, [prompt], adapter, request.max_tokens)[0]
    return completion_response(request.model, completion)
