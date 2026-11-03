import logging
import os
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from sqlalchemy.orm import Session, sessionmaker

from minibrain.api import (
    audit,
    cards,
    catalog,
    compute,
    connections,
    data,
    dataset_folders,
    feedback,
    install,
    internal,
    internal_gateway,
    jobs,
    keys,
    minibrains,
    model_cache,
    models,
    ops,
    policies,
    system,
    versions,
)
from minibrain.api.audit import PeerAddress
from minibrain.api.catalog import schedule_forever
from minibrain.artifacts import ArtifactError
from minibrain.base_models import BaseModelSpec
from minibrain.connections.spec import ConnectionProblem
from minibrain.connections.store import sync_declared
from minibrain.data.extensions import configure as configure_extensions
from minibrain.data.feedback import FeedbackError, database_feedback
from minibrain.data.snapshot import SnapshotError
from minibrain.data.sources import SourceError
from minibrain.gateway import routes as gateway
from minibrain.gateway.config import LocalConfig
from minibrain.gateway.logs import LogBuffer, database_sink
from minibrain.jobs.effects import DomainEffects
from minibrain.jobs.queue import JobStateError, LeaseError, SqlJobQueue
from minibrain.leader import Leader, leader_for
from minibrain.maintenance import purge_forever
from minibrain.models import hub
from minibrain.models.cache import CacheKeeper
from minibrain.models.catalog import seed
from minibrain.models.health import report_problems
from minibrain.models.registry import model_folder
from minibrain.object_store import apply as apply_storage
from minibrain.policy import LockedError, PolicyError
from minibrain.policy import load as load_policy
from minibrain.recent_logs import capture
from minibrain.registry.db import make_sessions, migrate
from minibrain.registry.files import MissingArtifactError, backfill, store_for
from minibrain.registry.service import ConflictError, NotFoundError
from minibrain.serve.backend import EngineUnavailableError, ServingBackend
from minibrain.serve.engines import EngineBackend, EngineManager, ManagedEngineBackend
from minibrain.settings import Settings, load_settings
from minibrain.tags import TagError

EXPIRY_SECONDS = 5.0
API_PREFIXES = ("api/", "v1/", "internal/", "healthz", "readyz", "metrics")

ERROR_STATUS: dict[type[Exception], int] = {
    NotFoundError: 404,
    ConflictError: 409,
    LeaseError: 409,
    JobStateError: 409,
    MissingArtifactError: 409,
    SourceError: 422,
    TagError: 422,
    SnapshotError: 422,
    FeedbackError: 422,
    ArtifactError: 422,
    EngineUnavailableError: 503,
    PolicyError: 403,
    LockedError: 409,
    ConnectionProblem: 422,
}

log = logging.getLogger("minibrain")


async def domain_error(_request: Request, error: Exception) -> JSONResponse:
    return JSONResponse(status_code=ERROR_STATUS.get(type(error), 400), content={"detail": str(error)})


def mount_web(app: FastAPI, dist: Path, ui_url: str | None = None) -> None:
    root = dist.resolve()

    @app.get("/{path:path}", include_in_schema=False)
    def web(path: str, request: Request) -> Response:
        if path.startswith(API_PREFIXES):
            raise HTTPException(status_code=404)
        if ui_url:
            query = f"?{request.url.query}" if request.url.query else ""
            return RedirectResponse(f"{ui_url}/{path.lstrip('/')}{query}")
        if not (root / "index.html").exists():
            raise HTTPException(status_code=404)
        candidate = (root / path).resolve()
        if path and candidate.is_file() and candidate.is_relative_to(root):
            return FileResponse(candidate)
        return FileResponse(root / "index.html")


def hub_allowed(sessions: sessionmaker[Session]) -> bool:
    with sessions() as session:
        return load_policy(session).outbound_allowed(hub.endpoint())


def no_engines(_bases: dict[str, BaseModelSpec], _registered: dict[str, list[dict[str, str]]]) -> dict[str, str]:
    return {}


def expire_forever(queue: SqlJobQueue, stop: threading.Event, leader: Leader) -> None:
    while not stop.wait(EXPIRY_SECONDS):
        try:
            if leader.held():
                queue.expire()
        except Exception:
            log.exception("lease expiry failed")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    stop = threading.Event()
    if app.state.background:
        leader = app.state.leader
        for target, args in (
            (expire_forever, (app.state.queue, stop, leader)),
            (schedule_forever, (app.state.sessions, stop, leader)),
            (purge_forever, (app.state.sessions, app.state.settings, stop, leader)),
            (app.state.cache.forever, (stop, leader)),
            (LocalConfig.refresh_forever, (app.state.gateway_config, stop)),
            (LogBuffer.flush_forever, (app.state.request_logs, stop)),
        ):
            threading.Thread(target=target, args=args, daemon=True).start()
        if isinstance(app.state.backend, EngineBackend):
            threading.Thread(target=app.state.backend.probe_forever, args=(stop,), daemon=True).start()
    yield
    stop.set()
    app.state.leader.release()
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
    configure_extensions(settings.home)
    capture()
    migrate(settings.database_url)
    sessions = make_sessions(settings.database_url)
    with sessions() as session:
        backfill(session, settings)
        seed(session)
        sync_declared(session)
        session.commit()
        report_problems(session, lambda model: model_folder(settings, model))
    app = FastAPI(title="minibrain", version="0.0.0", lifespan=lifespan)
    app.state.settings = settings
    app.state.sessions = sessions
    app.state.leader = leader_for(settings.database_url)
    app.state.store = store_for(settings)
    with sessions() as session:
        apply_storage(app.state.store, session, settings)
    app.state.cache = CacheKeeper(sessions, settings)
    app.state.queue = SqlJobQueue(sessions, DomainEffects(settings, app.state.cache.wake))
    app.state.queue.grace()
    engines = None
    if backend is None:
        main_url = os.environ.get("MINIBRAIN_MAIN_URL", "http://127.0.0.1:8000")
        engines = EngineManager(settings, main_url, hub_allowed=lambda: hub_allowed(sessions))
        backend = ManagedEngineBackend(engines, lambda: app.state.gateway_config.current().engines)
    app.state.engines = engines
    app.state.backend = backend
    app.state.gateway_config = LocalConfig(
        sessions, app.state.store, settings, engines.ensure if engines else no_engines, max_age=config_max_age
    )
    app.state.request_logs = LogBuffer(database_sink(sessions))
    app.state.feedback = database_feedback(sessions)
    app.state.background = background
    for error in ERROR_STATUS:
        app.add_exception_handler(error, domain_error)
    app.add_exception_handler(gateway.OpenAIError, gateway.openai_error)
    app.add_middleware(PeerAddress)
    for module in (
        minibrains,
        data,
        dataset_folders,
        connections,
        models,
        model_cache,
        catalog,
        compute,
        policies,
        audit,
        versions,
        cards,
        feedback,
        keys,
        jobs,
        install,
        system,
        gateway,
        internal,
        internal_gateway,
        ops,
    ):
        app.include_router(module.router)
    mount_web(app, settings.web_dist, settings.ui_url)
    return app
