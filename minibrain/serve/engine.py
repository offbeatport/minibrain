from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from minibrain.artifacts import ArtifactStore
from minibrain.base_models import base_model
from minibrain.serve.backend import AdapterRef, CompletionRequest, ServingBackend, TransformersBackend
from minibrain.worker import HttpClient, StreamReader


class AdapterBody(BaseModel):
    name: str
    artifact: dict[str, Any]


class GenerateBody(BaseModel):
    messages: list[dict[str, str]]
    adapter: AdapterBody | None = None
    max_tokens: int = 64


class GenerateResult(BaseModel):
    text: str
    prompt_tokens: int
    completion_tokens: int
    stopped: bool
    seconds: float


def artifact_fetcher(store: ArtifactStore, http: HttpClient, token: str):
    headers = {"Authorization": f"Bearer {token}"}

    def materialize(artifact: dict[str, Any]) -> Path:
        if not store.has(artifact["id"]):
            with http.stream("GET", f"/internal/gateway/artifacts/{artifact['id']}", headers=headers) as response:
                response.raise_for_status()
                store.put_stream(StreamReader(response.iter_bytes()), expected=artifact["id"])
        return store.materialize(artifact["id"], artifact["packing"], artifact["name"])

    return materialize


def create_engine_app(
    base: str,
    main_url: str,
    token: str,
    home: Path,
    backend: ServingBackend | None = None,
    http: HttpClient | None = None,
) -> FastAPI:
    spec = base_model(base)
    store = ArtifactStore(home / "artifacts", home / "cache")
    client: HttpClient = http or httpx.Client(base_url=main_url, timeout=httpx.Timeout(120.0, connect=10.0))
    serving = backend or TransformersBackend(artifact_fetcher(store, client, token))
    state = {"ready": False}

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        if isinstance(serving, TransformersBackend):
            serving.runtime(spec)
        state["ready"] = True
        yield

    app = FastAPI(title=f"minibrain engine {base}", lifespan=lifespan)

    @app.get("/health")
    def health() -> dict[str, Any]:
        if not state["ready"]:
            raise HTTPException(status_code=503, detail="loading")
        loaded = next((item for item in serving.status() if item["base_model"] == base), None)
        return {
            "base_model": base,
            "adapters": (loaded or {}).get("adapters", []),
            "device": (loaded or {}).get("device"),
        }

    @app.post("/generate")
    def generate(body: GenerateBody) -> GenerateResult:
        adapter = AdapterRef(body.adapter.name, body.adapter.artifact) if body.adapter else None
        completion = serving.complete(CompletionRequest(spec, body.messages, adapter, body.max_tokens))
        return GenerateResult(**completion.__dict__)

    return app
