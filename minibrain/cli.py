import argparse
import ipaddress
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import uvicorn

RESTART_DELAYS = (1.0, 2.0, 5.0, 10.0, 30.0)
HEALTHY_SECONDS = 60.0


class Supervisor:
    def __init__(self, name: str, command: list[str], env: dict[str, str]) -> None:
        self.name = name
        self.command = command
        self.env = env
        self.stop = threading.Event()
        self.process: subprocess.Popen[bytes] | None = None
        self.thread = threading.Thread(target=self.loop, daemon=True)

    def start(self) -> None:
        self.thread.start()

    def loop(self) -> None:
        failures = 0
        while not self.stop.is_set():
            started = time.monotonic()
            self.process = subprocess.Popen(self.command, env=self.env)
            code = self.process.wait()
            if self.stop.is_set():
                return
            failures = 0 if time.monotonic() - started > HEALTHY_SECONDS else failures + 1
            delay = RESTART_DELAYS[min(failures, len(RESTART_DELAYS) - 1)]
            print(f"minibrain: {self.name} exited with {code}; restarting in {delay:.0f}s", file=sys.stderr, flush=True)
            self.stop.wait(delay)

    def shutdown(self) -> None:
        self.stop.set()
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                self.process.kill()


def local_url(host: str, port: int) -> str:
    try:
        unspecified = ipaddress.ip_address(host).is_unspecified
    except ValueError:
        unspecified = False
    return f"http://{'127.0.0.1' if unspecified else host}:{port}"


def serve(host: str, port: int, with_worker: bool) -> None:
    from minibrain.settings import load_settings

    settings = load_settings()
    api_url = local_url(host, port)
    env = os.environ | {"MINIBRAIN_WORKER_TOKEN": settings.secret("worker_token")}
    command = [sys.executable, "-m", "minibrain.cli", "worker", "--api-url", api_url, "--parent", str(os.getpid())]
    worker = Supervisor("worker", command, env) if with_worker else None
    if worker is not None:
        worker.start()
    try:
        uvicorn.run("minibrain.app:create_app", factory=True, host=host, port=port)
    finally:
        if worker is not None:
            worker.shutdown()


def watch_parent(parent: int | None, stop: threading.Event) -> None:
    while parent is not None and not stop.wait(2.0):
        if os.getppid() != parent:
            stop.set()


def worker(api_url: str, kinds: list[str] | None, gpus: int, parent: int | None) -> None:
    from minibrain.settings import load_settings
    from minibrain.worker import MODULES, Worker, WorkerConfig

    settings = load_settings()
    token = os.environ.get("MINIBRAIN_WORKER_TOKEN") or settings.secret("worker_token")
    config = WorkerConfig(
        api_url=api_url, token=token, home=settings.home / "worker", kinds=kinds or list(MODULES), gpus=gpus
    )
    stop = threading.Event()
    threading.Thread(target=watch_parent, args=(parent, stop), daemon=True).start()
    Worker(config).run_forever(stop)


def openapi(output: Path | None) -> None:
    from minibrain.app import create_app

    schema = json.dumps(create_app(run_expiry=False).openapi(), indent=2)
    if output is None:
        print(schema)
    else:
        output.write_text(schema + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(prog="minibrain")
    commands = parser.add_subparsers(dest="command", required=True)
    serve_command = commands.add_parser("serve", help="run main (UI, API, gateway) and a local worker")
    serve_command.add_argument("--host", default="127.0.0.1")
    serve_command.add_argument("--port", type=int, default=8000)
    serve_command.add_argument("--no-worker", action="store_true")
    worker_command = commands.add_parser("worker", help="run a worker against a main process")
    worker_command.add_argument("--api-url", default="http://127.0.0.1:8000")
    worker_command.add_argument("--kinds", nargs="*", default=None)
    worker_command.add_argument("--gpus", type=int, default=1)
    worker_command.add_argument("--parent", type=int, default=None, help=argparse.SUPPRESS)
    openapi_command = commands.add_parser("openapi", help="print the OpenAPI schema")
    openapi_command.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()
    if args.command == "serve":
        serve(args.host, args.port, not args.no_worker)
    elif args.command == "worker":
        worker(args.api_url, args.kinds, args.gpus, args.parent)
    else:
        openapi(args.output)


if __name__ == "__main__":
    main()
