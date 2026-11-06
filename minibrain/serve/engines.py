import json
import logging
import os
import socket
import sys
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import ExitStack
from dataclasses import asdict
from typing import Any

import httpx

from minibrain.base_models import BaseModelSpec
from minibrain.gateway.balance import Balancer, sticky_key
from minibrain.ml.completion import Completion, Piece
from minibrain.serve.backend import CompletionRequest, EngineUnavailableError, Event, OutputFormatError
from minibrain.serve.sampling import UnsupportedParameterError
from minibrain.settings import Settings
from minibrain.supervise import Supervisor
from minibrain.worker import HttpClient

GENERATE_TIMEOUT = httpx.Timeout(300.0, connect=5.0)
STARTUP_SECONDS = 600.0
FETCH_WAIT_SECONDS = 60.0
FETCHING = "fetching"
IDLE_SECONDS = 900.0
PROBE_SECONDS = 5.0
FAILED_STATUS = 500

log = logging.getLogger("minibrain.engines")


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class EngineManager:
    def __init__(
        self,
        settings: Settings,
        main_url: str,
        idle_seconds: float = IDLE_SECONDS,
        hub_allowed: Callable[[], bool] = lambda: True,
    ) -> None:
        self.settings = settings
        self.main_url = main_url
        self.idle_seconds = idle_seconds
        self.hub_allowed = hub_allowed
        self.engines: dict[str, tuple[str, Supervisor]] = {}
        self.used: dict[str, float] = {}
        self.lock = threading.Lock()

    def start(self, spec: BaseModelSpec) -> str:
        port = free_port()
        command = [
            sys.executable,
            "-m",
            "minibrain.cli",
            "engine",
            "--spec",
            json.dumps(spec.as_dict()),
            "--port",
            str(port),
            "--main-url",
            self.main_url,
            "--parent",
            str(os.getpid()),
        ]
        env = os.environ | {"MINIBRAIN_GATEWAY_TOKEN": self.settings.secret("gateway_token")}
        if not self.hub_allowed():
            env |= {"HF_HUB_OFFLINE": "1"}
        supervisor = Supervisor(f"engine {spec.key}", command, env)
        supervisor.start()
        url = f"http://127.0.0.1:{port}"
        self.engines[spec.key] = (url, supervisor)
        self.used[spec.key] = time.monotonic()
        return url

    def ensure(
        self,
        specs: dict[str, BaseModelSpec],
        registered: dict[str, list[dict[str, str]]],
        releasing: frozenset[str] = frozenset(),
    ) -> dict[str, str]:
        with self.lock:
            own = {key: url for key, (url, _) in self.engines.items()}
            elsewhere = {
                key for key, entries in registered.items() if any(entry["url"] != own.get(key) for entry in entries)
            }
            for key, spec in specs.items():
                if key not in self.engines and key not in elsewhere:
                    self.start(spec)
            self.reap({key for key in specs if key not in elsewhere}, releasing)
            return {key: url for key, (url, _) in self.engines.items()}

    def reap(self, keep: set[str], releasing: frozenset[str] = frozenset()) -> None:
        moment = time.monotonic()
        for key in [key for key in self.engines if key not in keep]:
            if key in releasing or moment - self.used.get(key, 0.0) > self.idle_seconds:
                _, supervisor = self.engines.pop(key)
                log.info("stopping the engine for %s", key)
                supervisor.shutdown()

    def ensure_one(self, spec: BaseModelSpec) -> str:
        with self.lock:
            found = self.engines.get(spec.key)
            return found[0] if found else self.start(spec)

    def touch(self, key: str) -> None:
        self.used[key] = time.monotonic()

    def stop_one(self, key: str) -> None:
        with self.lock:
            found = self.engines.pop(key, None)
        if found is not None:
            found[1].shutdown()

    def url(self, base: str) -> str | None:
        found = self.engines.get(base)
        return found[0] if found else None

    def health(self, key: str, http: HttpClient) -> str | None:
        found = self.engines.get(key)
        if found is None:
            return None
        url, supervisor = found
        try:
            response = http.request("GET", f"{url}/health")
        except (httpx.TransportError, OSError):
            response = None
        if response is not None and response.status_code == 200:
            return "running"
        if response is not None and fetching(response) is not None:
            return FETCHING
        failed = response is not None and response.status_code == FAILED_STATUS
        return "unhealthy" if failed or supervisor.restarts > 0 else "starting"

    def stop(self) -> None:
        for _, supervisor in self.engines.values():
            supervisor.shutdown()


Engines = Callable[[], dict[str, list[dict[str, str]]]]
DRAIN_TIMEOUT = httpx.Timeout(10.0, connect=3.0)


def drain_engine(http: HttpClient, url: str, routes: list[str], adapters: list[str]) -> dict[str, Any]:
    response = http.request("POST", f"{url}/drain", json={"routes": routes, "adapters": adapters})
    response.raise_for_status()
    return dict(response.json())


def fetching(response: Any) -> str | None:
    if response.status_code != 503:
        return None
    try:
        detail = response.json().get("detail")
    except ValueError:
        return None
    if isinstance(detail, dict) and detail.get("state") == FETCHING:
        return str(detail.get("message") or FETCHING)
    return None


def engine_detail(response: Any) -> str:
    try:
        return str(response.json().get("detail") or response.text)
    except ValueError:
        return response.text


def failed(response: Any) -> None:
    if response.status_code in (FAILED_STATUS, 409):
        raise EngineUnavailableError(engine_detail(response))
    if response.status_code == 400:
        raise refusal(response)
    response.raise_for_status()


def refusal(response: Any) -> Exception:
    try:
        detail = response.json().get("detail")
    except ValueError:
        detail = None
    if isinstance(detail, dict) and detail.get("code") == "unsupported_parameter":
        return UnsupportedParameterError(str(detail.get("param")), str(detail.get("message")))
    return OutputFormatError(engine_detail(response))


class EngineBackend:
    def __init__(self, engines: Engines, http: HttpClient | None = None, balancer: Balancer | None = None) -> None:
        self.engines = engines
        self.http: HttpClient = http or httpx.Client(timeout=GENERATE_TIMEOUT)
        self.probe: HttpClient = httpx.Client(timeout=httpx.Timeout(1.0))
        self.balancer = balancer or Balancer()

    def replicas(self, base: str) -> list[dict[str, str]]:
        return self.engines().get(base, [])

    def body_of(self, request: CompletionRequest) -> dict[str, Any]:
        adapter = (
            {"name": request.adapter.name, "artifact": request.adapter.artifact, "base_hash": request.adapter.base_hash}
            if request.adapter
            else None
        )
        body = {
            "messages": request.messages,
            "adapter": adapter,
            "max_tokens": request.max_tokens,
            "route": request.route,
            "sampling": request.sampling.given(),
            "tools": list(request.tools.tools),
            "tool_choice": request.tools.choice,
            "parallel_tool_calls": request.tools.parallel,
            "reasoning": request.reasoning,
            "template_extra": request.template_extra,
        }
        if request.constraint is not None:
            body["constraint"] = asdict(request.constraint)
        return body

    def send(self, url: str, body: dict[str, Any], stream: bool) -> tuple[Any, ExitStack]:
        stack = ExitStack()
        if not stream:
            return self.http.request("POST", f"{url}/generate", json=body), stack
        try:
            response = stack.enter_context(self.http.stream("POST", f"{url}/generate", json=body | {"stream": True}))
            if response.status_code != 200:
                response.read()
        except BaseException:
            stack.close()
            raise
        return response, stack

    def opened(self, request: CompletionRequest, stream: bool) -> tuple[Any, ExitStack]:
        base = request.base.key
        body = self.body_of(request)
        key = sticky_key(base, request.adapter.name if request.adapter else None, request.messages)
        started = time.monotonic()
        deadline = started + STARTUP_SECONDS
        tried: set[str] = set()
        waiting: str | None = None
        while True:
            replicas = self.replicas(base)
            if not replicas:
                raise EngineUnavailableError(f"no engine serves {base}")
            url = self.balancer.choose(replicas, key, tried)
            if url is None:
                if waiting is not None and time.monotonic() - started > FETCH_WAIT_SECONDS:
                    raise EngineUnavailableError(waiting)
                if time.monotonic() > deadline:
                    raise EngineUnavailableError(f"no engine for {base} is reachable")
                time.sleep(1.0)
                tried.clear()
                waiting = None
                continue
            try:
                response, stack = self.send(url, body, stream)
            except (httpx.TransportError, OSError):
                self.balancer.release(url)
                self.balancer.mark(url, "down")
                tried.add(url)
                continue
            stack.callback(self.balancer.release, url)
            if response.status_code == 503:
                stack.close()
                self.balancer.mark(url, "loading")
                tried.add(url)
                waiting = fetching(response)
                if waiting is not None:
                    deadline = time.monotonic() + STARTUP_SECONDS
                continue
            if response.status_code != 200:
                stack.close()
                failed(response)
            self.balancer.mark(url, "ready")
            if tried:
                self.balancer.rebind(key, url)
            return response, stack

    def complete(self, request: CompletionRequest) -> Completion:
        response, stack = self.opened(request, False)
        with stack:
            return Completion.from_dict(response.json())

    def stream(self, request: CompletionRequest) -> Iterator[Event]:
        response, stack = self.opened(request, True)
        with stack:
            for line in response.iter_lines():
                if not line.strip():
                    continue
                found = json.loads(line)
                if "error" in found:
                    raise EngineUnavailableError(str(found["error"].get("detail") or "the engine failed"))
                if "completion" in found:
                    yield Completion.from_dict(found["completion"])
                else:
                    yield Piece.from_dict(found["piece"])

    def check(self, url: str) -> str:
        try:
            response = self.probe.request("GET", f"{url}/health")
        except (httpx.TransportError, OSError):
            return "down"
        return "ready" if response.status_code == 200 else "loading" if response.status_code == 503 else "down"

    def check_all(self) -> None:
        urls = {entry["url"] for entries in self.engines().values() for entry in entries}
        for url in sorted(urls):
            self.balancer.mark(url, self.check(url))

    def probe_forever(self, stop: threading.Event) -> None:
        while not stop.wait(PROBE_SECONDS):
            try:
                self.check_all()
            except Exception:
                log.exception("engine health check failed")

    def status(self) -> list[dict[str, Any]]:
        return []


class ManagedEngineBackend(EngineBackend):
    def __init__(self, manager: EngineManager, engines: Engines, http: HttpClient | None = None) -> None:
        super().__init__(engines, http)
        self.manager = manager

    def replicas(self, base: str) -> list[dict[str, str]]:
        found = self.engines().get(base, [])
        local = self.manager.url(base)
        if local is not None and all(entry["url"] != local for entry in found):
            found = [{"url": local, "state": "loading"}, *found]
        return found

    def complete(self, request: CompletionRequest) -> Completion:
        self.started(request)
        return super().complete(request)

    def stream(self, request: CompletionRequest) -> Iterator[Event]:
        self.started(request)
        return super().stream(request)

    def started(self, request: CompletionRequest) -> None:
        if not self.engines().get(request.base.key):
            self.manager.ensure_one(request.base)
        self.manager.touch(request.base.key)

    def health(self, key: str) -> str | None:
        if any(self.balancer.state(entry) == "ready" for entry in self.engines().get(key, [])):
            return "running"
        return self.manager.health(key, self.probe)

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
