import logging
import socket
import threading
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import asdict
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import PlainTextResponse, Response

from minibrain.data.feedback import Submission
from minibrain.gateway import routes
from minibrain.gateway.config import REPORT_SECONDS, GatewayConfig, RemoteConfig, gateway_id, served_bases
from minibrain.gateway.logs import LogBuffer, LogEntry
from minibrain.serve.backend import ServingBackend
from minibrain.serve.engines import EngineBackend
from minibrain.telemetry.context import RequestContext
from minibrain.telemetry.logs import configure_logging
from minibrain.telemetry.prometheus import load_metrics_access, metrics_response
from minibrain.telemetry.setup import gateway_telemetry
from minibrain.worker import HttpClient

log = logging.getLogger("minibrain.gateway")


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

    def send_feedback(submission: Submission) -> int:
        try:
            response = client.request("POST", "/internal/gateway/feedback", json=asdict(submission), headers=headers)
        except Exception as error:
            detail = "main is unreachable, so the feedback was not stored; send it again"
            raise HTTPException(status_code=503, detail=detail) from error
        if response.status_code in (404, 422):
            raise HTTPException(status_code=response.status_code, detail=response.json().get("detail"))
        response.raise_for_status()
        return int(response.json()["id"])

    identity = {"id": gateway_id("gateway"), "host": socket.gethostname()}
    reported: dict[str, Any] = {"version": "", "at": 0.0}

    def report(config: GatewayConfig) -> None:
        if config.version == reported["version"] and time.monotonic() - reported["at"] < REPORT_SECONDS:
            return
        body = identity | {"version": config.version, "routes": sorted(config.routes), "bases": served_bases(config)}
        try:
            client.request("POST", "/internal/gateway/gateways", json=body, headers=headers).raise_for_status()
        except Exception:
            log.warning("could not tell main which config this gateway serves")
            return
        reported.update(version=config.version, at=time.monotonic())

    source = RemoteConfig(fetch, home / "gateway-config.json", report)
    logs = LogBuffer(ship)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        configure_logging()
        stop = threading.Event()
        if background:
            threading.Thread(target=source.follow, args=(stop,), daemon=True).start()
            threading.Thread(target=logs.flush_forever, args=(stop,), daemon=True).start()
            if isinstance(serving, EngineBackend):
                threading.Thread(target=serving.probe_forever, args=(stop,), daemon=True).start()
        yield
        stop.set()
        app.state.telemetry.shutdown()

    app = FastAPI(title="minibrain gateway", lifespan=lifespan)
    app.state.gateway_config = source
    app.state.request_logs = logs
    app.state.feedback = send_feedback
    serving = backend or EngineBackend(lambda: source.current().engines)
    app.state.backend = serving
    app.state.metrics_access = load_metrics_access()
    app.state.telemetry = gateway_telemetry(app.state.metrics_access)
    app.state.telemetry.refresh()
    app.add_exception_handler(routes.OpenAIError, routes.openai_error)
    app.add_middleware(RequestContext)
    app.include_router(routes.router)

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/readyz")
    def readyz() -> dict[str, str]:
        if source.current().version == "empty":
            raise HTTPException(status_code=503, detail="no config yet")
        return {"status": "ready", "config": source.current().version}

    @app.get("/metrics", response_class=PlainTextResponse)
    def metrics(request: Request) -> Response:
        return metrics_response(request)

    return app
