import argparse
import ipaddress
import json
import os
import signal
import socket
import sys
import threading
from collections.abc import Callable
from pathlib import Path

import uvicorn

from minibrain.supervise import Supervisor


def local_url(host: str, port: int) -> str:
    try:
        unspecified = ipaddress.ip_address(host).is_unspecified
    except ValueError:
        unspecified = False
    return f"http://{'127.0.0.1' if unspecified else host}:{port}"


def serve(host: str, port: int, with_worker: bool) -> None:
    from minibrain.settings import load_settings
    from minibrain.worker import LOCAL_KINDS

    settings = load_settings()
    api_url = local_url(host, port)
    os.environ["MINIBRAIN_MAIN_URL"] = api_url
    env = os.environ | {"MINIBRAIN_WORKER_TOKEN": settings.secret("worker_token")}
    command = [sys.executable, "-m", "minibrain.cli", "worker", "--api-url", api_url, "--parent", str(os.getpid())]
    command += ["--kinds", *LOCAL_KINDS]
    worker = Supervisor("worker", command, env) if with_worker else None
    if worker is not None:
        worker.start()
    try:
        uvicorn.run("minibrain.app:create_app", factory=True, host=host, port=port)
    finally:
        if worker is not None:
            worker.shutdown()


def watch_parent(parent: int | None, stop: threading.Event, on_orphan: Callable[[], None] | None = None) -> None:
    while parent is not None and not stop.wait(2.0):
        if os.getppid() != parent:
            stop.set()
            if on_orphan is not None:
                on_orphan()


def terminate_self() -> None:
    os.kill(os.getpid(), signal.SIGTERM)


def advertised_url(host: str, port: int, explicit: str | None) -> str:
    if explicit:
        return explicit.rstrip("/")
    try:
        unspecified = ipaddress.ip_address(host).is_unspecified
    except ValueError:
        unspecified = False
    return f"http://{socket.getfqdn() if unspecified else host}:{port}"


def engine(args: argparse.Namespace) -> None:
    import httpx

    from minibrain.base_models import BaseModelSpec
    from minibrain.serve.engine import create_engine_app, pull_base
    from minibrain.settings import load_settings

    settings = load_settings()
    token = os.environ.get("MINIBRAIN_GATEWAY_TOKEN") or settings.secret("gateway_token")
    client = httpx.Client(base_url=args.main_url, timeout=httpx.Timeout(120.0, connect=10.0))
    if args.spec:
        spec = BaseModelSpec.from_dict(json.loads(args.spec))
    elif args.model:
        spec = pull_base(client, token, args.model, settings.home / "engines" / args.model / "weights")
    else:
        raise SystemExit("minibrain engine needs --model")
    app = create_engine_app(
        spec,
        args.main_url,
        token,
        settings.home / "engines" / spec.key,
        http=client,
        url=advertised_url(args.host, args.port, args.url),
        pool=args.pool,
        requested=args.engine,
    )
    threading.Thread(target=watch_parent, args=(args.parent, threading.Event(), terminate_self), daemon=True).start()
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


def gateway(main_url: str, host: str, port: int) -> None:
    from minibrain.gateway.standalone import create_gateway_app
    from minibrain.settings import load_settings

    settings = load_settings()
    token = os.environ.get("MINIBRAIN_GATEWAY_TOKEN") or settings.secret("gateway_token")
    uvicorn.run(create_gateway_app(main_url, token, settings.home / "gateway"), host=host, port=port)


def worker(api_url: str, kinds: list[str] | None, gpus: int, parent: int | None, pool: str) -> None:
    from minibrain.models.hardware import report
    from minibrain.settings import load_settings
    from minibrain.worker import REMOTE_KINDS, Worker, WorkerConfig

    settings = load_settings()
    token = os.environ.get("MINIBRAIN_WORKER_TOKEN") or settings.secret("worker_token")
    config = WorkerConfig(
        api_url=api_url,
        token=token,
        home=settings.home / "worker",
        kinds=kinds or [str(kind) for kind in REMOTE_KINDS],
        gpus=gpus,
        pool=pool,
        hardware=report().as_dict(),
    )
    stop = threading.Event()
    threading.Thread(target=watch_parent, args=(parent, stop), daemon=True).start()
    Worker(config).run_forever(stop)


def openapi(output: Path | None) -> None:
    from minibrain.app import create_app

    schema = json.dumps(create_app(background=False).openapi(), indent=2)
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
    worker_command.add_argument("--pool", default="local", help="compute pool this machine joins")
    worker_command.add_argument("--parent", type=int, default=None, help=argparse.SUPPRESS)
    gateway_command = commands.add_parser("gateway", help="run a standalone gateway against a main process")
    gateway_command.add_argument("--main-url", default="http://127.0.0.1:8000")
    gateway_command.add_argument("--host", default="127.0.0.1")
    gateway_command.add_argument("--port", type=int, default=8100)
    engine_command = commands.add_parser("engine", help="serve one model on this machine for a main process")
    engine_command.add_argument("--model", default=None, help="model key, as shown on the Models page")
    engine_command.add_argument("--main-url", default="http://127.0.0.1:8000")
    engine_command.add_argument("--pool", default="local", help="compute pool this machine joins")
    engine_command.add_argument("--host", default="127.0.0.1")
    engine_command.add_argument("--port", type=int, default=8200)
    engine_command.add_argument("--url", default=None, help="address gateways use to reach this engine")
    engine_command.add_argument(
        "--engine", default="auto", choices=["auto", "sglang", "mlx", "transformers", "llamacpp"]
    )
    engine_command.add_argument("--spec", default=None, help=argparse.SUPPRESS)
    engine_command.add_argument("--parent", type=int, default=None, help=argparse.SUPPRESS)
    openapi_command = commands.add_parser("openapi", help="print the OpenAPI schema")
    openapi_command.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()
    if args.command == "serve":
        serve(args.host, args.port, not args.no_worker)
    elif args.command == "worker":
        worker(args.api_url, args.kinds, args.gpus, args.parent, args.pool)
    elif args.command == "gateway":
        gateway(args.main_url, args.host, args.port)
    elif args.command == "engine":
        engine(args)
    else:
        openapi(args.output)


if __name__ == "__main__":
    main()
