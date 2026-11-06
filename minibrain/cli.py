import argparse
import ipaddress
import json
import os
import signal
import socket
import sys
import threading
import time
import webbrowser
from collections.abc import Callable
from dataclasses import asdict
from functools import partial
from pathlib import Path
from typing import TYPE_CHECKING

import uvicorn

from minibrain.supervise import Supervisor

COMMAND_LINE = "command line"
DEFAULT_URL = "http://127.0.0.1:8000"
MPS_FALLBACK_ENV = "PYTORCH_ENABLE_MPS_FALLBACK"
STARTUP_FAILURE = 3
REPEAT_SIGNAL_SECONDS = 2.0
RULE = "-" * 78

if TYPE_CHECKING:
    from types import FrameType

    from minibrain.auth.first_run import FirstRun
    from minibrain.registry.audit_chain import ChainReport
    from minibrain.settings import Settings


def local_url(host: str, port: int) -> str:
    try:
        unspecified = ipaddress.ip_address(host).is_unspecified
    except ValueError:
        unspecified = False
    return f"http://{'127.0.0.1' if unspecified else host}:{port}"


def setup_banner(link: str, note: str = "Lost it? minibrain admin setup-link prints a new one.") -> str:
    lines = ["minibrain has no admin account yet. Create it with this one-time setup link:", "", f"  {link}", "", note]
    return "\n".join(["", RULE, *(f"  {line}" if line else "" for line in lines), RULE, ""])


def desktop_session() -> bool:
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        return False
    if any(os.environ.get(name) for name in ("CI", "SSH_CONNECTION", "SSH_TTY", "container")):
        return False
    if Path("/.dockerenv").exists():
        return False
    if sys.platform.startswith("linux"):
        return bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))
    return True


def first_start(settings: "Settings") -> "FirstRun":
    from minibrain.auth.config import load_auth
    from minibrain.auth.first_run import FirstRunError, prepare
    from minibrain.registry.db import make_sessions, migrate

    migrate(settings.database_url)
    with make_sessions(settings.database_url)() as session:
        try:
            return prepare(session, load_auth(), os.environ)
        except FirstRunError as error:
            raise SystemExit(str(error)) from error


def announce(server: uvicorn.Server, found: "FirstRun", base: str, browser: bool) -> None:
    from minibrain.auth.first_run import ADMIN_EMAIL_ENV, setup_link

    while not server.started:
        time.sleep(0.1)
    if found.token is not None:
        link = setup_link(base, found.token)
        print(setup_banner(link), flush=True)
        if browser:
            webbrowser.open(link)
    elif found.waiting:
        note = "Open the setup link printed when it first started, or run minibrain admin setup-link for a new one."
        print(f"\n{RULE}\n  minibrain has no admin account yet. {note}\n{RULE}\n", flush=True)
    elif found.admin is not None:
        print(f"Created the admin account {found.admin} from {ADMIN_EMAIL_ENV}.", flush=True)


def checked_config() -> None:
    from minibrain.provision import ConfigError, problems

    try:
        problems()
    except ConfigError as error:
        raise SystemExit(f"minibrain.yaml: {error}") from error


def serve(host: str, port: int, with_worker: bool, browser: bool) -> None:
    from minibrain.settings import load_settings
    from minibrain.worker import LOCAL_KINDS

    checked_config()
    settings = load_settings()
    api_url = local_url(host, port)
    os.environ["MINIBRAIN_MAIN_URL"] = api_url
    found = first_start(settings)
    env = os.environ | {"MINIBRAIN_WORKER_TOKEN": settings.secret("worker_token")}
    command = [sys.executable, "-m", "minibrain.cli", "worker", "--api-url", api_url, "--parent", str(os.getpid())]
    command += ["--kinds", *LOCAL_KINDS]
    worker = Supervisor("worker", command, env) if with_worker else None
    if worker is not None:
        worker.start()
    config = uvicorn.Config(
        "minibrain.app:create_app",
        factory=True,
        host=host,
        port=port,
        proxy_headers=False,
        timeout_graceful_shutdown=10,
    )
    server = QuietServer(config, partial(begin_stop, worker))
    opens = browser and desktop_session()
    threading.Thread(target=announce, args=(server, found, settings.ui_url or api_url, opens), daemon=True).start()
    try:
        server.run()
    except KeyboardInterrupt:
        pass
    finally:
        if worker is not None:
            worker.shutdown()
    if not server.started:
        raise SystemExit(STARTUP_FAILURE)
    print("minibrain: stopped", file=sys.stderr, flush=True)


class QuietServer(uvicorn.Server):
    def __init__(self, config: uvicorn.Config, on_stop: Callable[[], None]) -> None:
        super().__init__(config)
        self.on_stop = on_stop
        self.first_signal: float | None = None

    def handle_exit(self, sig: int, frame: "FrameType | None") -> None:
        now = time.monotonic()
        if self.first_signal is None:
            self.first_signal = now
            print("minibrain: stopping…", file=sys.stderr, flush=True)
            self.on_stop()
        elif now - self.first_signal < REPEAT_SIGNAL_SECONDS:
            return
        super().handle_exit(sig, frame)


def begin_stop(worker: Supervisor | None) -> None:
    from minibrain.lifecycle import STOPPING

    STOPPING.set()
    if worker is not None:
        threading.Thread(target=worker.shutdown, daemon=True).start()


def exit_quietly(signum: int, frame: "FrameType | None") -> None:
    raise SystemExit(0)


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
    from minibrain.serve.engine import create_engine_app, local_copy, prune_engines, remote_base
    from minibrain.settings import load_settings

    settings = load_settings()
    token = os.environ.get("MINIBRAIN_GATEWAY_TOKEN") or settings.secret("gateway_token")
    client = httpx.Client(base_url=args.main_url, timeout=httpx.Timeout(120.0, connect=10.0))
    if args.spec:
        spec = BaseModelSpec.from_dict(json.loads(args.spec))
        fetch = partial(local_copy, client, token, spec)
    elif args.model:
        try:
            prune_engines(client, token, settings.home / "engines")
        except httpx.HTTPError:
            print("could not check this machine's model copies against main", flush=True)
        spec, fetch = remote_base(client, token, args.model, settings.home / "engines" / args.model / "weights")
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
        managed=args.parent is not None,
        fetch=fetch,
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
        models=settings.home / "models" if parent is not None else None,
        prune=parent is None,
    )
    stop = threading.Event()
    threading.Thread(target=watch_parent, args=(parent, stop), daemon=True).start()
    signal.signal(signal.SIGTERM, exit_quietly)
    signal.signal(signal.SIGINT, exit_quietly)
    Worker(config).run_forever(stop)


def check_outbound(url: str) -> None:
    from minibrain.policy import load as load_policy
    from minibrain.registry.db import make_sessions, migrate
    from minibrain.settings import load_settings

    settings = load_settings()
    migrate(settings.database_url)
    with make_sessions(settings.database_url)() as session:
        load_policy(session).outbound(url)


def extensions(args: argparse.Namespace) -> None:
    import duckdb

    from minibrain.data import extensions as duck
    from minibrain.policy import PolicyError

    names = getattr(args, "names", None) or list(duck.PURPOSES)
    try:
        if args.action == "install":
            source = args.source or duck.repository()
            if not source:
                raise SystemExit(f"give --from <folder or mirror URL>, or set {duck.REPOSITORY_ENV}")
            if "://" in source:
                check_outbound(source)
            wanted = args.names or duck.bundled(source)
            if not wanted:
                raise SystemExit(f"{source} has no extensions for DuckDB {duck.engine_version()} on {duck.platform()}")
            done = duck.install(source, wanted)
            print(f"Installed {', '.join(done)} into {duck.directory()}")
        elif args.action == "download":
            check_outbound(args.source)
            platforms = args.platform or [duck.platform()]
            saved = duck.download(args.to, platforms, names, args.source, args.version)
            print(f"Saved {len(saved)} files under {args.to}")
            print(f"Install them on the server with: minibrain extensions install --from {args.to}")
            return
    except (PolicyError, duckdb.Error) as error:
        raise SystemExit(str(error)) from error
    print(f"DuckDB {duck.engine_version()} on {duck.platform()}, extensions in {duck.directory()}")
    for state in duck.status():
        print(f"  {state.name:<18} {'installed' if state.installed else 'missing':<10} {state.purpose}")


def chain_summary(report: "ChainReport") -> str:
    if report.broken is not None:
        found = f" (event {report.broken.event_id})" if report.broken.event_id is not None else ""
        verified = f" Verified up to seq {report.last_seq}." if report.events else ""
        return f"Audit chain broken at seq {report.broken.seq}{found}: {report.broken.reason}.{verified}"
    if report.events == 0:
        text = "Audit chain verified: no sealed events"
    else:
        text = f"Audit chain verified: {report.events} events, seq {report.first_seq} to {report.last_seq}"
    if report.anchor_seq:
        text += f", starting after the prune at seq {report.anchor_seq}"
    if report.pending == 1:
        text += ". 1 newer event is not sealed yet"
    elif report.pending:
        text += f". {report.pending} newer events are not sealed yet"
    return text + "."


def audit(args: argparse.Namespace) -> None:
    from minibrain.registry.audit_chain import verify, verify_records

    if args.file is not None:
        lines = args.file.read_text().splitlines()
        report = verify_records(json.loads(line) for line in lines if line.strip())
    else:
        from minibrain.registry.db import make_sessions, migrate
        from minibrain.settings import load_settings

        settings = load_settings()
        migrate(settings.database_url)
        with make_sessions(settings.database_url)() as session:
            report = verify(session)
    if args.json:
        print(json.dumps(asdict(report) | {"verified": report.verified}, indent=2))
    else:
        print(chain_summary(report))
    if not report.verified:
        raise SystemExit(1)


def encryption_keys(args: argparse.Namespace) -> None:
    from minibrain.encryption.commands import run

    run(args)


def read_new_password(from_stdin: bool) -> str:
    import getpass

    if from_stdin:
        return sys.stdin.readline().rstrip("\n")
    first = getpass.getpass("Password (at least 12 characters): ")
    if getpass.getpass("Password again: ") != first:
        raise SystemExit("The passwords do not match")
    return first


def checked_password(from_stdin: bool) -> str:
    from minibrain.auth.passwords import PasswordError, check_strength

    password = read_new_password(from_stdin)
    try:
        check_strength(password)
    except PasswordError as error:
        raise SystemExit(str(error)) from error
    return password


def admin_create(args: argparse.Namespace) -> None:
    from minibrain.auth.accounts import AccountError, create_local
    from minibrain.auth.first_run import clear_setup_token
    from minibrain.auth.roles import Role
    from minibrain.registry.db import make_sessions, migrate
    from minibrain.registry.models import AuditEvent
    from minibrain.registry.service import ConflictError
    from minibrain.settings import load_settings

    password = checked_password(args.password_stdin)
    settings = load_settings()
    migrate(settings.database_url)
    with make_sessions(settings.database_url)() as session:
        try:
            user = create_local(session, args.email, args.name, Role.ADMIN, password)
        except (AccountError, ConflictError) as error:
            raise SystemExit(str(error)) from error
        detail = {"name": user.name, "role": Role.ADMIN.value, "source": "local", "via": COMMAND_LINE}
        session.add(AuditEvent(actor=COMMAND_LINE, action="account.create", target=user.subject, detail=detail))
        clear_setup_token(session)
        session.commit()
    print(f"Created the admin account {user.subject}. Sign in with it in the minibrain UI.")


def admin_reset_password(args: argparse.Namespace) -> None:
    from minibrain.auth.accounts import AccountError, find_local, normal_email, set_password
    from minibrain.registry.db import make_sessions, migrate
    from minibrain.registry.models import AuditEvent
    from minibrain.settings import load_settings

    try:
        email = normal_email(args.email)
    except AccountError as error:
        raise SystemExit(str(error)) from error
    settings = load_settings()
    migrate(settings.database_url)
    with make_sessions(settings.database_url)() as session:
        user = find_local(session, email)
        if user is None:
            raise SystemExit(f"{email} has no local account. minibrain admin create adds one.")
        set_password(session, user, checked_password(args.password_stdin))
        detail = {"via": COMMAND_LINE}
        session.add(AuditEvent(actor=COMMAND_LINE, action="account.password", target=user.subject, detail=detail))
        session.commit()
        disabled = user.disabled
    print(f"Set a new password for {email} and ended its sessions. Sign in with it in the minibrain UI.")
    if disabled:
        print("The account is turned off: another admin turns it back on under Settings, Accounts.")


def admin_setup_link(args: argparse.Namespace) -> None:
    from minibrain.auth.accounts import users_exist
    from minibrain.auth.config import load_auth
    from minibrain.auth.first_run import issue_setup_token, setup_link, sso_admin
    from minibrain.registry.db import make_sessions, migrate
    from minibrain.settings import load_settings

    settings = load_settings()
    migrate(settings.database_url)
    with make_sessions(settings.database_url)() as session:
        if users_exist(session):
            raise SystemExit("This install already has accounts. Sign in, or run minibrain admin reset-password.")
        if sso_admin(session, load_auth()):
            raise SystemExit(
                "minibrain.yaml maps a single sign-on group to admin, so sign in with single sign-on."
                " minibrain admin create adds a local admin."
            )
        token = issue_setup_token(session, COMMAND_LINE)
        session.commit()
    base = args.url or settings.ui_url or DEFAULT_URL
    print(setup_banner(setup_link(base, token), "Earlier setup links no longer work."))


def admin(args: argparse.Namespace) -> None:
    if args.action == "create":
        admin_create(args)
    elif args.action == "reset-password":
        admin_reset_password(args)
    else:
        admin_setup_link(args)


def openapi(output: Path | None) -> None:
    from minibrain.app import create_app

    schema = json.dumps(create_app(background=False).openapi(), indent=2)
    if output is None:
        print(schema)
    else:
        output.write_text(schema + "\n")


def config_command(args: argparse.Namespace) -> None:
    from minibrain.config_export import export, render
    from minibrain.registry.db import make_sessions, migrate
    from minibrain.settings import load_settings

    checked_config()
    settings = load_settings()
    migrate(settings.database_url)
    with make_sessions(settings.database_url)() as session:
        text = render(*export(session, settings))
    if args.output is None:
        print(text, end="")
    else:
        args.output.write_text(text)


def main() -> None:
    os.environ.setdefault(MPS_FALLBACK_ENV, "1")
    parser = argparse.ArgumentParser(prog="minibrain")
    commands = parser.add_subparsers(dest="command", required=True)
    serve_command = commands.add_parser("serve", help="run main (UI, API, gateway) and a local worker")
    serve_command.add_argument("--host", default="127.0.0.1")
    serve_command.add_argument("--port", type=int, default=8000)
    serve_command.add_argument("--no-worker", action="store_true")
    serve_command.add_argument(
        "--no-browser", action="store_true", help="do not open the setup link in a browser on first start"
    )
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
    extensions_command = commands.add_parser(
        "extensions",
        help="list, install or download the DuckDB extensions S3, database, Iceberg and Delta Lake sources use",
    )
    actions = extensions_command.add_subparsers(dest="action")
    actions.add_parser("status", help="show which extensions are installed")
    install_command = actions.add_parser("install", help="install from a local folder or an internal mirror")
    install_command.add_argument("--from", dest="source", default=None, help="folder or mirror URL")
    install_command.add_argument("names", nargs="*")
    download_command = actions.add_parser("download", help="save extensions to a folder on a connected machine")
    download_command.add_argument("--to", type=Path, required=True)
    download_command.add_argument("--platform", action="append", default=None, help="for example linux_amd64")
    download_command.add_argument("--from", dest="source", default="https://extensions.duckdb.org")
    download_command.add_argument("--version", default=None, help="DuckDB version, such as v2.0.0")
    download_command.add_argument("names", nargs="*")
    audit_command = commands.add_parser("audit", help="check the audit log's hash chain")
    audit_actions = audit_command.add_subparsers(dest="action", required=True)
    verify_command = audit_actions.add_parser("verify", help="walk the chain and report the first break")
    verify_command.add_argument("--file", type=Path, default=None, help="a full JSONL export instead of the database")
    verify_command.add_argument("--json", action="store_true", help="print the report as JSON")
    keys_command = commands.add_parser("keys", help="encryption at rest: key status, rotation, encrypting old files")
    keys_actions = keys_command.add_subparsers(dest="action", required=True)
    keys_status = keys_actions.add_parser("status", help="show the key provider, key versions and what files use")
    keys_status.add_argument("--json", action="store_true", help="print the report as JSON")
    keys_rotate = keys_actions.add_parser("rotate", help="make a new master key version and re-wrap every data key")
    keys_rotate.add_argument("--retire-now", action="store_true", help="drop old local keys now; no server running")
    keys_actions.add_parser("encrypt-existing", help="encrypt files written before encryption at rest, in place")
    admin_command = commands.add_parser("admin", help="manage admin accounts")
    admin_actions = admin_command.add_subparsers(dest="action", required=True)
    create_command = admin_actions.add_parser("create", help="create an admin account with a password")
    create_command.add_argument("--email", required=True)
    create_command.add_argument("--name", default="")
    create_command.add_argument("--password-stdin", action="store_true", help="read the password from standard input")
    reset_command = admin_actions.add_parser(
        "reset-password", help="set a new password for a local account, unlock it and end its sessions"
    )
    reset_command.add_argument("--email", required=True)
    reset_command.add_argument("--password-stdin", action="store_true", help="read the password from standard input")
    link_command = admin_actions.add_parser(
        "setup-link", help="print a new one-time link that creates the first admin; earlier links stop working"
    )
    link_command.add_argument("--url", default=None, help=f"address people open minibrain at (default {DEFAULT_URL})")
    config_parser = commands.add_parser("config", help="the settings file, minibrain.yaml")
    config_actions = config_parser.add_subparsers(dest="action", required=True)
    export_command = config_actions.add_parser(
        "export", help="print the effective settings as minibrain.yaml, with secrets named but never included"
    )
    export_command.add_argument("--output", type=Path, default=None)
    openapi_command = commands.add_parser("openapi", help="print the OpenAPI schema")
    openapi_command.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()
    if args.command == "serve":
        serve(args.host, args.port, not args.no_worker, not args.no_browser)
    elif args.command == "worker":
        worker(args.api_url, args.kinds, args.gpus, args.parent, args.pool)
    elif args.command == "gateway":
        gateway(args.main_url, args.host, args.port)
    elif args.command == "engine":
        engine(args)
    elif args.command == "extensions":
        extensions(args)
    elif args.command == "keys":
        encryption_keys(args)
    elif args.command == "audit":
        audit(args)
    elif args.command == "admin":
        admin(args)
    elif args.command == "config":
        config_command(args)
    else:
        openapi(args.output)


if __name__ == "__main__":
    main()
