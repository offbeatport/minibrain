import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException

from minibrain.gateway import routes
from minibrain.gateway.config import GatewayConfig, RemoteConfig
from minibrain.gateway.logs import LogBuffer, LogEntry
from minibrain.serve.backend import ServingBackend
from minibrain.serve.engines import EngineBackend
from minibrain.worker import HttpClient


def create_gateway_app(
    main_url: str,
    token: str,
    home: Path,
    http: HttpClient | None = None,
    backend: ServingBackend | None = None,
    background: bool = True,
) -> FastAPI:
    client: HttpClient = http or httpx.Client(base_url=main_url, timeout=httpx.Timeout(60.0, connect=10.0))
    headers = {"Authorization": f"Bearer {token}"}

    def fetch(version: str, wait: float) -> GatewayConfig | None:
        response = client.request("GET", f"/internal/gateway/config?version={version}&wait={wait}", headers=headers)
        if response.status_code == 304:
            return None
        response.raise_for_status()
        return GatewayConfig.from_json(response.text)

    def ship(batch: list[LogEntry]) -> None:
        body = {"entries": [entry.as_json() for entry in batch]}
        client.request("POST", "/internal/gateway/logs", json=body, headers=headers).raise_for_status()

    source = RemoteConfig(fetch, home / "gateway-config.json")
    logs = LogBuffer(ship)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        stop = threading.Event()
        if background:
            threading.Thread(target=source.follow, args=(stop,), daemon=True).start()
            threading.Thread(target=logs.flush_forever, args=(stop,), daemon=True).start()
        yield
        stop.set()

    app = FastAPI(title="minibrain gateway", lifespan=lifespan)
    app.state.gateway_config = source
    app.state.request_logs = logs
    app.state.backend = backend or EngineBackend(lambda base: source.current().engines.get(base))
    app.include_router(routes.router)

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/readyz")
    def readyz() -> dict[str, str]:
        if source.current().version == "empty":
            raise HTTPException(status_code=503, detail="no config yet")
        return {"status": "ready", "config": source.current().version}

    return app
