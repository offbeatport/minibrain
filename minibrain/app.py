import logging
import os
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse

from minibrain.api import (
    catalog,
    compute,
    internal,
    internal_gateway,
    jobs,
    minibrains,
    models,
    ops,
    policies,
    system,
    versions,
)
from minibrain.api.catalog import schedule_forever
from minibrain.artifacts import ArtifactError
from minibrain.base_models import BaseModelSpec
from minibrain.data.snapshot import SnapshotError
from minibrain.data.sources import SourceError
from minibrain.gateway import routes as gateway
from minibrain.gateway.config import LocalConfig
from minibrain.gateway.logs import LogBuffer, database_sink
from minibrain.jobs.effects import DomainEffects
from minibrain.jobs.queue import JobStateError, LeaseError, SqlJobQueue
from minibrain.maintenance import purge_forever
from minibrain.models.catalog import seed
from minibrain.policy import LockedError, PolicyError
from minibrain.registry.db import make_sessions, migrate
from minibrain.registry.files import MissingArtifactError, backfill, store_for
from minibrain.registry.service import ConflictError, NotFoundError
from minibrain.serve.backend import EngineUnavailableError, ServingBackend
from minibrain.serve.engines import EngineManager, ManagedEngineBackend
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
    EngineUnavailableError: 503,
    PolicyError: 403,
    LockedError: 409,
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


def no_engines(_bases: dict[str, BaseModelSpec], _registered: dict[str, list[dict[str, str]]]) -> dict[str, str]:
    return {}


def expire_forever(queue: SqlJobQueue, stop: threading.Event) -> None:
    while not stop.wait(EXPIRY_SECONDS):
        try:
            queue.expire()
        except Exception:
            log.exception("lease expiry failed")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    stop = threading.Event()
    if app.state.background:
        for target, source in (
            (expire_forever, app.state.queue),
            (LocalConfig.refresh_forever, app.state.gateway_config),
            (LogBuffer.flush_forever, app.state.request_logs),
            (schedule_forever, app.state.sessions),
            (purge_forever, app.state.sessions),
        ):
            threading.Thread(target=target, args=(source, stop), daemon=True).start()
    yield
    stop.set()
    app.state.request_logs.flush()
    if app.state.engines is not None:
        app.state.engines.stop()


def create_app(
    settings: Settings | None = None,
    backend: ServingBackend | None = None,
    background: bool = True,
    config_max_age: float = 1.0,
) -> FastAPI:
    settings = settings or load_settings()
    migrate(settings.database_url)
    sessions = make_sessions(settings.database_url)
    with sessions() as session:
        backfill(session, settings)
        seed(session)
    app = FastAPI(title="minibrain", version="0.0.0", lifespan=lifespan)
    app.state.settings = settings
    app.state.sessions = sessions
    app.state.store = store_for(settings)
    app.state.queue = SqlJobQueue(sessions, DomainEffects(settings))
    app.state.queue.grace()
    engines = None
    if backend is None:
        engines = EngineManager(settings, os.environ.get("MINIBRAIN_MAIN_URL", "http://127.0.0.1:8000"))
        backend = ManagedEngineBackend(engines, lambda base: app.state.gateway_config.current().engines.get(base, []))
    app.state.engines = engines
    app.state.backend = backend
    app.state.gateway_config = LocalConfig(
        sessions, app.state.store, settings, engines.ensure if engines else no_engines, max_age=config_max_age
    )
    app.state.request_logs = LogBuffer(database_sink(sessions))
    app.state.background = background
    for error in ERROR_STATUS:
        app.add_exception_handler(error, domain_error)
    for module in (
        minibrains,
        models,
        catalog,
        compute,
        policies,
        versions,
        jobs,
        system,
        gateway,
        internal,
        internal_gateway,
        ops,
    ):
        app.include_router(module.router)
    mount_web(app, settings.web_dist)
    return app
