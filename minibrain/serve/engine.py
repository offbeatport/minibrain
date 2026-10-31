import logging
import threading
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from minibrain.artifacts import ArtifactStore
from minibrain.base_models import BaseModelSpec
from minibrain.models.hardware import LOCAL_POOL, NodeReport, report
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


ANNOUNCE_SECONDS = 10.0

log = logging.getLogger("minibrain.engine")


class Announcer:
    def __init__(self, client: HttpClient, token: str, body: dict[str, Any]) -> None:
        self.client = client
        self.headers = {"Authorization": f"Bearer {token}"}
        self.body = body

    def announce(self, state: str) -> None:
        body = self.body | {"state": state}
        self.client.request("POST", "/internal/gateway/engines", json=body, headers=self.headers).raise_for_status()

    def forever(self, ready: threading.Event, stop: threading.Event) -> None:
        while True:
            try:
                self.announce("ready" if ready.is_set() else "loading")
            except Exception:
                log.warning("could not reach main to announce this engine")
            if stop.wait(ANNOUNCE_SECONDS):
                return


def create_engine_app(
    spec: BaseModelSpec,
    main_url: str,
    token: str,
    home: Path,
    backend: ServingBackend | None = None,
    http: HttpClient | None = None,
    url: str | None = None,
    pool: str = LOCAL_POOL,
    node: NodeReport | None = None,
) -> FastAPI:
    base = spec.key
    store = ArtifactStore(home / "artifacts", home / "cache")
    client: HttpClient = http or httpx.Client(base_url=main_url, timeout=httpx.Timeout(120.0, connect=10.0))
    serving = backend or TransformersBackend(artifact_fetcher(store, client, token))
    engine = "transformers"
    ready = threading.Event()
    state = {"ready": False}

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        stop = threading.Event()
        if url is not None:
            hardware = node or report()
            body = {"id": uuid.uuid4().hex, "host": hardware.host, "url": url, "base_model": base, "engine": engine}
            announcer = Announcer(client, token, body | {"pool": pool, "hardware": hardware.as_dict()})
            threading.Thread(target=announcer.forever, args=(ready, stop), daemon=True).start()
        if isinstance(serving, TransformersBackend):
            serving.runtime(spec)
        state["ready"] = True
        ready.set()
        yield
        stop.set()

    app = FastAPI(title=f"minibrain engine {base}", lifespan=lifespan)

    @app.get("/health")
    def health() -> dict[str, Any]:
        if not state["ready"]:
            raise HTTPException(status_code=503, detail="loading")
        loaded = next((item for item in serving.status() if item["base_model"] == base), None)
        return {
            "base_model": base,
            "engine": engine,
            "adapters": (loaded or {}).get("adapters", []),
            "device": (loaded or {}).get("device"),
        }

    @app.post("/generate")
    def generate(body: GenerateBody) -> GenerateResult:
        adapter = AdapterRef(body.adapter.name, body.adapter.artifact) if body.adapter else None
        completion = serving.complete(CompletionRequest(spec, body.messages, adapter, body.max_tokens))
        return GenerateResult(**completion.__dict__)

    return app
