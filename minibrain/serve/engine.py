import logging
import threading
import uuid
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import replace
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from minibrain.artifacts import ArtifactStore
from minibrain.base_models import BaseModelSpec
from minibrain.models.hardware import LOCAL_POOL, NodeReport, report
from minibrain.serve.backend import (
    AdapterNotSupportedError,
    AdapterRef,
    CompletionRequest,
    EngineRuntime,
    ServingBackend,
    TransformersBackend,
)
from minibrain.serve.select import choose_engine
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
    def __init__(self, client: HttpClient, token: str, body: Callable[[], dict[str, Any]]) -> None:
        self.client = client
        self.headers = {"Authorization": f"Bearer {token}"}
        self.body = body

    def announce(self, state: str) -> None:
        body = self.body() | {"state": state}
        self.client.request("POST", "/internal/gateway/engines", json=body, headers=self.headers).raise_for_status()

    def forever(self, ready: threading.Event, stop: threading.Event) -> None:
        while True:
            try:
                self.announce("ready" if ready.is_set() else "loading")
            except Exception:
                log.warning("could not reach main to announce this engine")
            if stop.wait(ANNOUNCE_SECONDS):
                return


def make_backend(engine: str, materialize: Callable[[dict[str, Any]], Path]) -> EngineRuntime:
    if engine == "mlx":
        from minibrain.serve.mlx_backend import MlxBackend

        return MlxBackend(materialize)
    if engine == "llamacpp":
        from minibrain.serve.llamacpp_backend import LlamaCppBackend

        return LlamaCppBackend()
    if engine == "sglang":
        from minibrain.serve.sglang_backend import SglangBackend

        return SglangBackend(materialize)
    return TransformersBackend(materialize)


def load_backend(
    spec: BaseModelSpec, node: NodeReport, requested: str | None, materialize: Callable[[dict[str, Any]], Path]
) -> tuple[str, EngineRuntime]:
    engine = choose_engine(node, spec.format, requested)
    backend = make_backend(engine, materialize)
    try:
        backend.load(spec)
    except Exception:
        if requested not in (None, "auto") or engine == "transformers" or spec.format == "gguf":
            raise
        log.exception("%s could not load %s; falling back to transformers", engine, spec.key)
        engine, backend = "transformers", TransformersBackend(materialize)
        backend.load(spec)
    return engine, backend


def pull_base(client: HttpClient, token: str, key: str, folder: Path) -> BaseModelSpec:
    headers = {"Authorization": f"Bearer {token}"}
    response = client.request("GET", f"/internal/gateway/bases/{key}", headers=headers)
    response.raise_for_status()
    found = response.json()
    for entry in found["files"]:
        target = folder / entry["path"]
        if target.is_file() and target.stat().st_size == entry["size"]:
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        partial = target.with_name(target.name + ".partial")
        with client.stream("GET", f"/internal/gateway/bases/{key}/files/{entry['path']}", headers=headers) as stream:
            stream.raise_for_status()
            with partial.open("wb") as out:
                for chunk in stream.iter_bytes():
                    out.write(chunk)
        partial.replace(target)
    return replace(BaseModelSpec.from_dict(found["spec"]), path=str(folder))


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
    requested: str | None = None,
) -> FastAPI:
    base = spec.key
    store = ArtifactStore(home / "artifacts", home / "cache")
    client: HttpClient = http or httpx.Client(base_url=main_url, timeout=httpx.Timeout(120.0, connect=10.0))
    materialize = artifact_fetcher(store, client, token)
    ready = threading.Event()
    current: dict[str, Any] = {"engine": requested or "transformers", "backend": backend}

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        stop = threading.Event()
        hardware = node or report()
        if current["backend"] is None:
            current["engine"] = choose_engine(hardware, spec.format, requested)
        if url is not None:
            body = {"id": uuid.uuid4().hex, "host": hardware.host, "url": url, "base_model": base}
            body |= {"pool": pool, "hardware": hardware.as_dict()}
            announcer = Announcer(client, token, lambda: body | {"engine": current["engine"]})
            threading.Thread(target=announcer.forever, args=(ready, stop), daemon=True).start()
        if current["backend"] is None:
            current["engine"], current["backend"] = load_backend(spec, hardware, requested, materialize)
        ready.set()
        yield
        stop.set()
        closing = getattr(current["backend"], "close", None)
        if closing is not None:
            closing()

    app = FastAPI(title=f"minibrain engine {base}", lifespan=lifespan)

    @app.get("/health")
    def health() -> dict[str, Any]:
        serving: ServingBackend | None = current["backend"]
        if not ready.is_set() or serving is None:
            raise HTTPException(status_code=503, detail="loading")
        loaded = next((item for item in serving.status() if item["base_model"] == base), None)
        return {
            "base_model": base,
            "engine": current["engine"],
            "adapters": (loaded or {}).get("adapters", []),
            "device": (loaded or {}).get("device"),
        }

    @app.post("/generate")
    def generate(body: GenerateBody) -> GenerateResult:
        serving: ServingBackend | None = current["backend"]
        if serving is None:
            raise HTTPException(status_code=503, detail="loading")
        adapter = AdapterRef(body.adapter.name, body.adapter.artifact) if body.adapter else None
        try:
            completion = serving.complete(CompletionRequest(spec, body.messages, adapter, body.max_tokens))
        except AdapterNotSupportedError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return GenerateResult(**completion.__dict__)

    return app
