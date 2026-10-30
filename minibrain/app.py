from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse

from minibrain.api import minibrains, system, versions
from minibrain.api.deps import Enqueue
from minibrain.data.snapshot import SnapshotError
from minibrain.data.sources import SourceError
from minibrain.gateway import routes as gateway
from minibrain.registry.db import make_sessions
from minibrain.registry.service import ConflictError, NotFoundError
from minibrain.serve.backend import ServingBackend, TransformersBackend
from minibrain.settings import Settings, load_settings

ERROR_STATUS: dict[type[Exception], int] = {
    NotFoundError: 404,
    ConflictError: 409,
    SourceError: 422,
    SnapshotError: 422,
}


def queue_job(job_id: int) -> object:
    from minibrain.worker import run_job

    return run_job(job_id)


async def domain_error(_request: Request, error: Exception) -> JSONResponse:
    return JSONResponse(status_code=ERROR_STATUS.get(type(error), 400), content={"detail": str(error)})


def mount_web(app: FastAPI, dist: Path) -> None:
    root = dist.resolve()

    @app.get("/{path:path}", include_in_schema=False)
    def web(path: str) -> FileResponse:
        if path.startswith(("api/", "v1/")) or not (root / "index.html").exists():
            raise HTTPException(status_code=404)
        candidate = (root / path).resolve()
        if path and candidate.is_file() and candidate.is_relative_to(root):
            return FileResponse(candidate)
        return FileResponse(root / "index.html")


def create_app(
    settings: Settings | None = None, backend: ServingBackend | None = None, enqueue: Enqueue | None = None
) -> FastAPI:
    settings = settings or load_settings()
    app = FastAPI(title="minibrain", version="0.0.0")
    app.state.settings = settings
    app.state.sessions = make_sessions(settings.database_url)
    app.state.backend = backend or TransformersBackend()
    app.state.enqueue = enqueue or queue_job
    for error in ERROR_STATUS:
        app.add_exception_handler(error, domain_error)
    app.include_router(minibrains.router)
    app.include_router(versions.router)
    app.include_router(system.router)
    app.include_router(gateway.router)
    mount_web(app, settings.web_dist)
    return app
