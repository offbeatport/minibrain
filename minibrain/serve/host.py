import ipaddress
import logging
import os
import socket
import sys
import threading
from collections.abc import Callable
from typing import Protocol
from urllib.parse import urlsplit

from minibrain.serve.engines import free_port
from minibrain.supervise import Supervisor
from minibrain.worker import MainClient, WorkerConfig, WorkerStoppedError

RECONCILE_SECONDS = 10.0
ENGINE_KEY_ENV = "MINIBRAIN_ENGINE_TOKEN"

log = logging.getLogger("minibrain.host")


class AdvertiseError(RuntimeError):
    pass


Resolve = Callable[[str], list[str]]
RouteTo = Callable[[str, int], str | None]
DEFAULT_PORTS = {"https": 443, "http": 80}


def addresses_of(name: str) -> list[str]:
    try:
        return sorted({str(info[4][0]) for info in socket.getaddrinfo(name, None)})
    except OSError:
        return []


def route_to(host: str, port: int) -> str | None:
    try:
        found = socket.getaddrinfo(host, port, type=socket.SOCK_DGRAM)
    except OSError:
        return None
    for family, kind, proto, _, address in found:
        try:
            with socket.socket(family, kind, proto) as probe:
                probe.connect(address)
                return str(probe.getsockname()[0])
        except OSError:
            continue
    return None


def loopback(address: str) -> bool:
    try:
        return ipaddress.ip_address(address.split("%", 1)[0]).is_loopback
    except ValueError:
        return address == "localhost"


def unreachable(name: str, found: list[str], main_url: str, pool: str) -> str:
    resolved = ", ".join(found) if found else "no address"
    return (
        f"This machine's name {name} resolves to {resolved}, which gateways on other machines cannot reach, and no "
        f"other address of this machine reaches main at {main_url}. Pass the address or name other machines reach "
        f"it at: minibrain worker --pool {pool} --advertise <address> (add --engine-bind 0.0.0.0 to listen on every "
        "interface), or --no-serve to run jobs only."
    )


def advertise_address(
    explicit: str | None,
    main_url: str,
    pool: str,
    name: str | None = None,
    resolve: Resolve = addresses_of,
    route: RouteTo = route_to,
) -> str:
    if explicit:
        return explicit
    name = name or socket.getfqdn()
    found = resolve(name)
    if found and not all(loopback(address) for address in found):
        return name
    parts = urlsplit(main_url)
    main_host = parts.hostname or ""
    if loopback(main_host):
        log.warning("%s resolves to %s: only gateways on this machine reach its engines", name, found or "nothing")
        return name if found else "127.0.0.1"
    source = route(main_host, parts.port or DEFAULT_PORTS.get(parts.scheme, 80))
    if source is None or loopback(source):
        raise AdvertiseError(unreachable(name, found, main_url, pool))
    log.warning("%s resolves to %s; engines advertise %s, the address that reaches main", name, found, source)
    return source


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
