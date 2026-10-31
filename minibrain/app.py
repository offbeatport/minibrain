import logging
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse

from minibrain.api import internal, jobs, minibrains, ops, system, versions
from minibrain.artifacts import ArtifactError
from minibrain.data.snapshot import SnapshotError
from minibrain.data.sources import SourceError
from minibrain.gateway import routes as gateway
from minibrain.jobs.effects import DomainEffects
from minibrain.jobs.queue import JobStateError, LeaseError, SqlJobQueue
from minibrain.registry.db import make_sessions, migrate
from minibrain.registry.files import MissingArtifactError, backfill, store_for
from minibrain.registry.service import ConflictError, NotFoundError
from minibrain.serve.backend import ServingBackend, TransformersBackend
from minibrain.settings import Settings, load_settings

EXPIRY_SECONDS = 5.0
API_PREFIXES = ("api/", "v1/", "internal/", "healthz", "readyz", "metrics")

ERROR_STATUS: dict[type[Exception], int] = {
    NotFoundError: 404,
    ConflictError: 409,
    LeaseError: 409,
    JobStateError: 409,
    MissingArtifactError: 409,
    SourceError: 422,
    SnapshotError: 422,
    ArtifactError: 422,
}

log = logging.getLogger("minibrain")


async def domain_error(_request: Request, error: Exception) -> JSONResponse:
    return JSONResponse(status_code=ERROR_STATUS.get(type(error), 400), content={"detail": str(error)})


def mount_web(app: FastAPI, dist: Path) -> None:
    root = dist.resolve()

    @app.get("/{path:path}", include_in_schema=False)
    def web(path: str) -> FileResponse:
        if path.startswith(API_PREFIXES) or not (root / "index.html").exists():
            raise HTTPException(status_code=404)
        candidate = (root / path).resolve()
        if path and candidate.is_file() and candidate.is_relative_to(root):
            return FileResponse(candidate)
        return FileResponse(root / "index.html")


def expire_forever(queue: SqlJobQueue, stop: threading.Event) -> None:
    while not stop.wait(EXPIRY_SECONDS):
        try:
            queue.expire()
        except Exception:
            log.exception("lease expiry failed")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    stop = threading.Event()
    if app.state.run_expiry:
        threading.Thread(target=expire_forever, args=(app.state.queue, stop), daemon=True).start()
    yield
    stop.set()


def create_app(
    settings: Settings | None = None, backend: ServingBackend | None = None, run_expiry: bool = True
) -> FastAPI:
    settings = settings or load_settings()
    migrate(settings.database_url)
    sessions = make_sessions(settings.database_url)
    with sessions() as session:
        backfill(session, settings)
    app = FastAPI(title="minibrain", version="0.0.0", lifespan=lifespan)
    app.state.settings = settings
    app.state.sessions = sessions
    app.state.store = store_for(settings)
    app.state.queue = SqlJobQueue(sessions, DomainEffects())
    app.state.queue.grace()
    app.state.backend = backend or TransformersBackend()
    app.state.run_expiry = run_expiry
    for error in ERROR_STATUS:
        app.add_exception_handler(error, domain_error)
    for module in (minibrains, versions, jobs, system, gateway, internal, ops):
        app.include_router(module.router)
    mount_web(app, settings.web_dist)
    return app
