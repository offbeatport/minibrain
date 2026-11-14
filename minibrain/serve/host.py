import logging
import os
import socket
import sys
import threading
from collections.abc import Callable
from typing import Protocol

from minibrain.serve.engines import free_port
from minibrain.supervise import Supervisor
from minibrain.worker import MainClient, WorkerConfig, WorkerStoppedError

RECONCILE_SECONDS = 10.0
ENGINE_KEY_ENV = "MINIBRAIN_ENGINE_TOKEN"

log = logging.getLogger("minibrain.host")


class Running(Protocol):
    def shutdown(self) -> None: ...


Launch = Callable[[str, str], Running]


def engine_command(config: WorkerConfig, key: str, port: int, advertise: str, bind: str) -> list[str]:
    return [
        sys.executable,
        "-m",
        "minibrain.cli",
        "engine",
        "--model",
        key,
        "--pool",
        config.pool,
        "--main-url",
        config.api_url,
        "--host",
        bind,
        "--port",
        str(port),
        "--url",
        f"http://{advertise}:{port}",
        "--parent",
        str(os.getpid()),
    ]


class EngineHost:
    def __init__(
        self,
        config: WorkerConfig,
        client: MainClient,
        advertise: str | None = None,
        bind: str | None = None,
        launch: Launch | None = None,
    ) -> None:
        self.config = config
        self.client = client
        self.advertise = advertise or socket.getfqdn()
        self.bind = bind or self.advertise
        self.launch = launch or self.start
        self.running: dict[str, Running] = {}
        self.lock = threading.Lock()

    def start(self, key: str, token: str) -> Running:
        command = engine_command(self.config, key, free_port(), self.advertise, self.bind)
        supervisor = Supervisor(f"engine {key}", command, os.environ | {ENGINE_KEY_ENV: token})
        supervisor.start()
        return supervisor

    def reconcile(self) -> set[str]:
        found = self.client.engines()
        wanted = {str(item["model"]) for item in found["engines"]}
        with self.lock:
            for key in sorted(wanted - self.running.keys()):
                log.info("starting an engine for %s in pool %s", key, self.config.pool)
                self.running[key] = self.launch(key, str(found["engine_token"]))
            for key in sorted(self.running.keys() - wanted):
                log.info("stopping the engine for %s; it is no longer placed here", key)
                self.running.pop(key).shutdown()
        return wanted

    def forever(self, stop: threading.Event) -> None:
        while not stop.is_set():
            try:
                self.reconcile()
            except WorkerStoppedError:
                break
            except Exception:
                log.warning("could not ask main which engines to run here")
            if stop.wait(RECONCILE_SECONDS):
                break
        self.stop_all()

    def stop_all(self) -> None:
        with self.lock:
            running, self.running = self.running, {}
        for supervisor in running.values():
            supervisor.shutdown()
