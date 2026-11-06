import json
import logging
import threading
import uuid
from collections import Counter
from collections.abc import AsyncIterator, Callable, Iterator
from contextlib import asynccontextmanager, contextmanager
from dataclasses import replace
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from minibrain.artifacts import ArtifactStore, StreamReader
from minibrain.base_models import BaseModelSpec
from minibrain.ml.completion import Completion, Piece
from minibrain.models.copies import BUCKET, Progress, bucket_client, ensure, opener_for, prune
from minibrain.models.hardware import LOCAL_POOL, NodeReport, report
from minibrain.models.health import CANT_RUN, NO_MEMORY, base_changed
from minibrain.serve.backend import (
    AdapterNotSupportedError,
    AdapterRef,
    CompletionRequest,
    EngineRuntime,
    Event,
    OutputFormatError,
    ServingBackend,
    TransformersBackend,
)
from minibrain.serve.dialects import ToolUse
from minibrain.serve.sampling import Sampling, UnsupportedParameterError
from minibrain.serve.select import NoEngineError, choose_engine
from minibrain.serve.structured import Constraint
from minibrain.telemetry.logs import configure_logging
from minibrain.worker import HttpClient

FETCHING = "fetching"
LOADING = "loading"
FETCH_FAILED = "fetch_failed"
GIB = 1024**3
PROGRESS_SECONDS = 30.0
Fetch = Callable[[Progress], Any]


def fetching_detail(base: str, host: str, progress: Progress) -> dict[str, Any]:
    share = f"{progress.done / GIB:.1f} of {progress.total / GIB:.1f} GB" if progress.total else "checking its files"
    message = f"{base} is fetching its weights on {host}: {share}; try again when it finishes"
    return {"state": FETCHING, "done": progress.done, "total": progress.total, "message": message}


class AdapterBody(BaseModel):
    name: str
    artifact: dict[str, Any]
    base_hash: str | None = None


class GenerateBody(BaseModel):
    messages: list[dict[str, Any]]
    adapter: AdapterBody | None = None
    max_tokens: int | None = None
    constraint: Constraint | None = None
    route: str | None = None
    sampling: dict[str, Any] = {}
    tools: list[dict[str, Any]] = []
    tool_choice: str | dict[str, Any] | None = None
    parallel_tool_calls: bool = True
    reasoning: str | None = None
    stream: bool = False

    def request(self, spec: BaseModelSpec, adapter: AdapterRef | None) -> CompletionRequest:
        return CompletionRequest(
            spec,
            self.messages,
            adapter,
            self.max_tokens,
            self.constraint,
            self.route,
            sampling=Sampling.from_dict(self.sampling),
            tools=ToolUse(tuple(self.tools), self.tool_choice, self.parallel_tool_calls),
            reasoning=self.reasoning,
        )


class DrainBody(BaseModel):
    routes: list[str] = []
    adapters: list[str] = []


class DrainResult(BaseModel):
    in_flight: int
    total: int
    loaded: list[str]


class Flights:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.routes: Counter[str] = Counter()
        self.adapters: Counter[str] = Counter()
        self.total = 0

    @contextmanager
    def flying(self, route: str | None, adapter: str | None) -> Iterator[None]:
        with self.lock:
            self.total += 1
            self.routes[route or ""] += 1
            self.adapters[adapter or ""] += 1
        try:
            yield
        finally:
            with self.lock:
                self.total -= 1
                self.routes[route or ""] -= 1
                self.adapters[adapter or ""] -= 1

    def on_routes(self, routes: list[str]) -> int:
        with self.lock:
            return sum(self.routes[route] for route in set(routes))

    def busy(self, adapter: str) -> bool:
        with self.lock:
            return self.adapters[adapter] > 0


def loaded_adapters(serving: ServingBackend, base: str) -> set[str]:
    found = next((item for item in serving.status() if item.get("base_model") == base), None)
    return set((found or {}).get("adapters") or [])


def unload_adapter(serving: ServingBackend, name: str) -> None:
    unload = getattr(serving, "unload_adapter", None)
    if unload is not None:
        unload(name)


def artifact_fetcher(store: ArtifactStore, http: HttpClient, token: str):
    headers = {"Authorization": f"Bearer {token}"}

    def materialize(artifact: dict[str, Any]) -> Path:
        if not store.has(artifact["id"]):
            with http.stream("GET", f"/internal/gateway/artifacts/{artifact['id']}", headers=headers) as response:
                response.raise_for_status()
                store.put_stream(StreamReader(response.iter_bytes()), expected=artifact["id"])
        return store.materialize(artifact["id"], artifact["packing"], artifact["name"])

    return materialize


UNSUPPORTED = "unsupported_parameter"


def events_of(serving: ServingBackend, request: CompletionRequest) -> Iterator[Event]:
    stream = getattr(serving, "stream", None)
    if stream is not None:
        yield from stream(request)
        return
    completion = serving.complete(request)
    yield Piece(content=completion.text, tool_calls=completion.tool_calls, reasoning=completion.reasoning or "")
    yield completion


def event_line(event: Event) -> str:
    key = "completion" if isinstance(event, Completion) else "piece"
    return json.dumps({key: event.as_dict()}) + "\n"


def ndjson(first: Event, events: Iterator[Event]) -> Iterator[str]:
    yield event_line(first)
    try:
        for event in events:
            yield event_line(event)
    except Exception as error:
        log.exception("the engine failed in the middle of an answer")
        yield json.dumps({"error": {"status": 500, "detail": str(error) or type(error).__name__}}) + "\n"


def unsupported_detail(error: UnsupportedParameterError) -> dict[str, str]:
    return {"code": UNSUPPORTED, "param": error.param, "message": error.message}


ANNOUNCE_SECONDS = 10.0
PRUNE_EVERY = 60

log = logging.getLogger("minibrain.engine")


INSTALL_HINTS = {
    "llama_cpp": "install minibrain[llamacpp] on this machine",
    "mlx_lm": "install minibrain[mlx] on this machine",
    "sglang": "install SGLang on this machine or set MINIBRAIN_SGLANG_PYTHON",
    "vllm": "install vLLM on this machine or set MINIBRAIN_VLLM_PYTHON",
}


def out_of_memory(error: BaseException) -> bool:
    text = str(error).lower()
    return isinstance(error, MemoryError) or type(error).__name__ == "OutOfMemoryError" or "out of memory" in text


def load_failure(error: BaseException, spec: BaseModelSpec, host: str) -> dict[str, str]:
    if out_of_memory(error):
        message = f"Ran out of memory loading {spec.key} on {host}: {str(error).splitlines()[0][:200]}."
        return {"code": NO_MEMORY, "error": message}
    if isinstance(error, ModuleNotFoundError) and error.name:
        hint = INSTALL_HINTS.get(error.name.split(".")[0], f"install the Python package {error.name}")
        return {"code": CANT_RUN, "error": f"{host} cannot load {spec.key}: {error.name} is not installed; {hint}."}
    if isinstance(error, NoEngineError):
        return {"code": CANT_RUN, "error": f"{error}."}
    first = str(error).splitlines()[0][:300] if str(error) else type(error).__name__
    return {"code": CANT_RUN, "error": f"{host} could not load {spec.key}: {first}."}


class Announcer:
    def __init__(
        self,
        client: HttpClient,
        token: str,
        body: Callable[[], dict[str, Any]],
        tick: Callable[[], Any] | None = None,
        phase: Callable[[], str] = lambda: LOADING,
    ) -> None:
        self.client = client
        self.headers = {"Authorization": f"Bearer {token}"}
        self.body = body
        self.tick = tick
        self.phase = phase
        self.count = 0

    def announce(self, state: str) -> None:
        body = self.body() | {"state": state}
        self.client.request("POST", "/internal/gateway/engines", json=body, headers=self.headers).raise_for_status()

    def forever(self, ready: threading.Event, stop: threading.Event, failed: threading.Event | None = None) -> None:
        while True:
            try:
                self.announce("failed" if failed and failed.is_set() else "ready" if ready.is_set() else self.phase())
            except Exception:
                log.warning("could not reach main to announce this engine")
            self.count += 1
            if self.tick is not None and self.count % PRUNE_EVERY == 0:
                try:
                    self.tick()
                except Exception:
                    log.warning("could not check this machine's model copies against main")
            if stop.wait(ANNOUNCE_SECONDS):
                return

    def farewell(self) -> None:
        try:
            self.announce("stopped")
        except Exception:
            log.warning("could not tell main that this engine stopped")


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
    if engine == "vllm":
        from minibrain.serve.vllm_backend import VllmBackend

        return VllmBackend(materialize)
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


def listing_of(client: HttpClient, token: str, key: str) -> dict[str, Any]:
    response = client.request("GET", f"/internal/gateway/bases/{key}", headers={"Authorization": f"Bearer {token}"})
    response.raise_for_status()
    return dict(response.json())


def copy_base(
    client: HttpClient, token: str, found: dict[str, Any], key: str, folder: Path, progress: Progress | None = None
) -> None:
    headers = {"Authorization": f"Bearer {token}"}
    with bucket_client() as bucket:
        files_url = f"/internal/gateway/bases/{key}/files"
        opener = opener_for(found, client, files_url, headers, bucket, lambda: listing_of(client, token, key))
        ensure(folder, found["files"], opener, found.get("content_hash"), progress)


def remote_base(client: HttpClient, token: str, key: str, folder: Path) -> tuple[BaseModelSpec, Fetch]:
    found = listing_of(client, token, key)
    spec = replace(BaseModelSpec.from_dict(found["spec"]), path=str(folder))
    return spec, lambda progress: copy_base(client, token, found, key, folder, progress)


def pull_base(client: HttpClient, token: str, key: str, folder: Path) -> BaseModelSpec:
    spec, fetch = remote_base(client, token, key, folder)
    fetch(Progress())
    return spec


def local_copy(client: HttpClient, token: str, spec: BaseModelSpec, progress: Progress | None = None) -> BaseModelSpec:
    if not spec.path or not spec.content_hash:
        return spec
    found = listing_of(client, token, spec.key)
    if found.get("store") == BUCKET:
        copy_base(client, token, found, spec.key, Path(spec.path), progress)
    return spec


def prune_engines(client: HttpClient, token: str, root: Path) -> list[str]:
    response = client.request("GET", "/internal/gateway/bases", headers={"Authorization": f"Bearer {token}"})
    response.raise_for_status()
    return prune(root, dict(response.json()["bases"]), lambda entry: entry / "weights")


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
    managed: bool = False,
    fetch: Fetch | None = None,
) -> FastAPI:
    base = spec.key
    store = ArtifactStore(home / "artifacts", home / "cache")
    client: HttpClient = http or httpx.Client(base_url=main_url, timeout=httpx.Timeout(120.0, connect=10.0))
    materialize = artifact_fetcher(store, client, token)
    ready = threading.Event()
    failed = threading.Event()
    flights = Flights()
    progress = Progress()
    phase = {"now": FETCHING if fetch is not None else LOADING}
    current: dict[str, Any] = {"engine": requested or "transformers", "backend": backend, "failure": None, "host": ""}

    def announced() -> dict[str, Any]:
        return {"engine": current["engine"]} | (current["failure"] or {})

    def fail(failure: dict[str, str]) -> None:
        current["failure"] = failure
        failed.set()

    def log_progress(stop: threading.Event) -> None:
        while not stop.wait(PROGRESS_SECONDS):
            log.info("%s", fetching_detail(base, current["host"], progress)["message"])

    def prepare(hardware: NodeReport) -> None:
        if fetch is not None:
            fetched = threading.Event()
            threading.Thread(target=log_progress, args=(fetched,), daemon=True).start()
            try:
                fetch(progress)
            except Exception as error:
                log.exception("could not fetch the weights of %s", spec.key)
                first = str(error).splitlines()[0][:300] if str(error) else type(error).__name__
                fail({"code": FETCH_FAILED, "error": f"{hardware.host} could not fetch {spec.key}: {first}."})
                return
            finally:
                fetched.set()
            log.info("fetched the weights of %s (%d bytes)", spec.key, progress.done)
        phase["now"] = LOADING
        if current["backend"] is None:
            try:
                current["engine"], current["backend"] = load_backend(spec, hardware, requested, materialize)
            except Exception as error:
                log.exception("could not load %s", spec.key)
                fail(load_failure(error, spec, hardware.host))
                return
        ready.set()

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        configure_logging()
        stop = threading.Event()
        hardware = node or report()
        current["host"] = hardware.host
        if current["backend"] is None:
            current["engine"] = choose_engine(hardware, spec.format, requested)
        announcer: Announcer | None = None
        if url is not None:
            body = {"id": uuid.uuid4().hex, "host": hardware.host, "url": url, "base_model": base}
            body |= {"pool": pool, "hardware": hardware.as_dict(), "managed": managed}
            announcer = Announcer(
                client,
                token,
                lambda: body | announced(),
                lambda: prune_engines(client, token, home.parent),
                lambda: phase["now"],
            )
            threading.Thread(target=announcer.forever, args=(ready, stop, failed), daemon=True).start()
        if fetch is None and current["backend"] is not None:
            ready.set()
        else:
            threading.Thread(target=prepare, args=(hardware,), daemon=True).start()
        yield
        stop.set()
        if announcer is not None:
            announcer.farewell()
        closing = getattr(current["backend"], "close", None)
        if closing is not None:
            closing()

    app = FastAPI(title=f"minibrain engine {base}", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)

    @app.get("/health")
    def health() -> dict[str, Any]:
        if current["failure"] is not None:
            raise HTTPException(status_code=500, detail=current["failure"]["error"])
        serving: ServingBackend | None = current["backend"]
        if phase["now"] == FETCHING:
            raise HTTPException(status_code=503, detail=fetching_detail(base, current["host"], progress))
        if not ready.is_set() or serving is None:
            raise HTTPException(status_code=503, detail=LOADING)
        loaded = next((item for item in serving.status() if item["base_model"] == base), None)
        return {
            "base_model": base,
            "engine": current["engine"],
            "adapters": (loaded or {}).get("adapters", []),
            "device": (loaded or {}).get("device"),
        }

    def flown(body: GenerateBody, serving: ServingBackend, adapter: AdapterRef | None) -> Iterator[Event]:
        with flights.flying(body.route, adapter.name if adapter else None):
            yield from events_of(serving, body.request(spec, adapter))

    @app.post("/generate", response_model=None)
    def generate(body: GenerateBody) -> dict[str, Any] | StreamingResponse:
        if current["failure"] is not None:
            raise HTTPException(status_code=500, detail=current["failure"]["error"])
        serving: ServingBackend | None = current["backend"]
        if phase["now"] == FETCHING:
            raise HTTPException(status_code=503, detail=fetching_detail(base, current["host"], progress))
        if not ready.is_set() or serving is None:
            raise HTTPException(status_code=503, detail=LOADING)
        if body.adapter is not None:
            mismatch = base_changed(body.adapter.name, base, body.adapter.base_hash, spec.content_hash)
            if mismatch is not None:
                raise HTTPException(status_code=409, detail=mismatch)
        adapter = AdapterRef(body.adapter.name, body.adapter.artifact) if body.adapter else None
        try:
            if body.stream:
                events = flown(body, serving, adapter)
                first = next(events)
                return StreamingResponse(ndjson(first, events), media_type="application/x-ndjson")
            with flights.flying(body.route, adapter.name if adapter else None):
                completion = serving.complete(body.request(spec, adapter))
        except AdapterNotSupportedError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        except OutputFormatError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except UnsupportedParameterError as error:
            raise HTTPException(status_code=400, detail=unsupported_detail(error)) from error
        return completion.as_dict()

    @app.post("/drain")
    def drain(body: DrainBody) -> DrainResult:
        serving: ServingBackend | None = current["backend"]
        in_flight = flights.on_routes(body.routes)
        if serving is None:
            return DrainResult(in_flight=in_flight, total=flights.total, loaded=[])
        if in_flight == 0:
            for name in body.adapters:
                if not flights.busy(name):
                    unload_adapter(serving, name)
        loaded = loaded_adapters(serving, base)
        return DrainResult(
            in_flight=in_flight, total=flights.total, loaded=[name for name in body.adapters if name in loaded]
        )

    return app
