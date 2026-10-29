import argparse
import json
import subprocess
import sys
from pathlib import Path

import uvicorn


def serve(host: str, port: int, with_worker: bool) -> None:
    worker = subprocess.Popen([sys.executable, "-m", "minibrain.cli", "worker"]) if with_worker else None
    try:
        uvicorn.run("minibrain.app:create_app", factory=True, host=host, port=port)
    finally:
        if worker is not None:
            worker.terminate()
            worker.wait(timeout=30)


def worker() -> None:
    from minibrain.worker import consume

    consume()


def openapi(output: Path | None) -> None:
    from minibrain.app import create_app

    schema = json.dumps(create_app().openapi(), indent=2)
    if output is None:
        print(schema)
    else:
        output.write_text(schema + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(prog="minibrain")
    commands = parser.add_subparsers(dest="command", required=True)
    serve_command = commands.add_parser("serve", help="run the API, the UI and a worker")
    serve_command.add_argument("--host", default="127.0.0.1")
    serve_command.add_argument("--port", type=int, default=8000)
    serve_command.add_argument("--no-worker", action="store_true")
    commands.add_parser("worker", help="run the job worker")
    openapi_command = commands.add_parser("openapi", help="print the OpenAPI schema")
    openapi_command.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()
    if args.command == "serve":
        serve(args.host, args.port, not args.no_worker)
    elif args.command == "worker":
        worker()
    else:
        openapi(args.output)


if __name__ == "__main__":
    main()
