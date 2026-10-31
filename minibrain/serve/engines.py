import os
import socket
import sys
import threading
import time
from collections.abc import Callable
from typing import Any

import httpx

from minibrain.ml.completion import Completion
from minibrain.serve.backend import CompletionRequest, EngineUnavailableError
from minibrain.settings import Settings
from minibrain.supervise import Supervisor
from minibrain.worker import HttpClient

GENERATE_TIMEOUT = httpx.Timeout(300.0, connect=5.0)
STARTUP_SECONDS = 600.0


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class EngineManager:
    def __init__(self, settings: Settings, main_url: str) -> None:
        self.settings = settings
        self.main_url = main_url
        self.engines: dict[str, tuple[str, Supervisor]] = {}
        self.lock = threading.Lock()

    def start(self, base: str) -> str:
        port = free_port()
        command = [
            sys.executable,
            "-m",
            "minibrain.cli",
            "engine",
            "--base",
            base,
            "--port",
            str(port),
            "--main-url",
            self.main_url,
            "--parent",
            str(os.getpid()),
        ]
        env = os.environ | {"MINIBRAIN_GATEWAY_TOKEN": self.settings.secret("gateway_token")}
        supervisor = Supervisor(f"engine {base}", command, env)
        supervisor.start()
        url = f"http://127.0.0.1:{port}"
        self.engines[base] = (url, supervisor)
        return url

    def ensure(self, bases: set[str]) -> dict[str, str]:
        with self.lock:
            for base in bases - set(self.engines):
                self.start(base)
            return {base: url for base, (url, _) in self.engines.items()}

    def url(self, base: str) -> str | None:
        found = self.engines.get(base)
        return found[0] if found else None

    def stop(self) -> None:
        for _, supervisor in self.engines.values():
            supervisor.shutdown()


class EngineBackend:
    def __init__(self, locate: Callable[[str], str | None], http: HttpClient | None = None) -> None:
        self.locate = locate
        self.http: HttpClient = http or httpx.Client(timeout=GENERATE_TIMEOUT)

    def complete(self, request: CompletionRequest) -> Completion:
        url = self.locate(request.base.key)
        if url is None:
            raise EngineUnavailableError(f"no engine serves {request.base.key}")
        adapter = {"name": request.adapter.name, "artifact": request.adapter.artifact} if request.adapter else None
        body = {"messages": request.messages, "adapter": adapter, "max_tokens": request.max_tokens}
        deadline = time.monotonic() + STARTUP_SECONDS
        while True:
            try:
                response = self.http.request("POST", f"{url}/generate", json=body)
            except (httpx.TransportError, OSError) as error:
                if time.monotonic() > deadline:
                    raise EngineUnavailableError(f"engine for {request.base.key} is not reachable") from error
                time.sleep(1.0)
                continue
            if response.status_code == 503 and time.monotonic() < deadline:
                time.sleep(1.0)
                continue
            response.raise_for_status()
            return Completion(**response.json())

    def status(self) -> list[dict[str, Any]]:
        return []


class ManagedEngineBackend(EngineBackend):
    def __init__(self, manager: EngineManager, http: HttpClient | None = None) -> None:
        super().__init__(lambda base: manager.ensure({base})[base], http)
        self.manager = manager

    def status(self) -> list[dict[str, Any]]:
        loaded: list[dict[str, Any]] = []
        for base, (url, _) in list(self.manager.engines.items()):
            try:
                response = self.http.request("GET", f"{url}/health")
            except (httpx.TransportError, OSError):
                continue
            if response.status_code == 200:
                loaded.append(response.json() | {"base_model": base})
        return loaded
