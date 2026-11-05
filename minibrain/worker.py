import json
import logging
import os
import platform
import queue
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager
from dataclasses import dataclass, field
from functools import partial
from pathlib import Path
from typing import IO, Any, BinaryIO, Protocol

import httpx

from minibrain.artifacts import CHUNK, ArtifactStore, Packing, StreamReader
from minibrain.ml.context import FINAL_EXIT
from minibrain.models.copies import BUCKET, bucket_client, ensure, matches, opener_for, prune
from minibrain.models.hardware import LOCAL_POOL
from minibrain.models.health import size_problems
from minibrain.registry.models import JobKind
from minibrain.telemetry.logs import configure_logging

MODULES: dict[str, str] = {
    JobKind.TRAIN: "minibrain.ml.train",
    JobKind.EVAL: "minibrain.ml.evaluate",
    JobKind.JUDGE: "minibrain.ml.judge",
    JobKind.DOWNLOAD: "minibrain.models.download",
    JobKind.IMPORT: "minibrain.models.importer",
    JobKind.CATALOG_SYNC: "minibrain.models.sync",
    JobKind.VERIFY: "minibrain.models.verify",
    JobKind.REPAIR: "minibrain.models.repair",
}
PASSTHROUGH_KINDS = (JobKind.DOWNLOAD, JobKind.IMPORT, JobKind.CATALOG_SYNC, JobKind.VERIFY, JobKind.REPAIR)
TRANSFER_KINDS = (JobKind.DOWNLOAD, JobKind.IMPORT, JobKind.REPAIR)
WEIGHTS = "weights"
PRUNE_SECONDS = 600.0
REMOTE_KINDS = [JobKind.TRAIN, JobKind.EVAL, JobKind.JUDGE]
LOCAL_KINDS = list(MODULES)
HEARTBEAT_SECONDS = 15.0
FLUSH_SECONDS = 1.0
CLAIM_WAIT_SECONDS = 25.0
RETRIES = 6
QUIET_ENV = {
    "HF_HUB_DISABLE_PROGRESS_BARS": "1",
    "HF_DATASETS_DISABLE_PROGRESS_BARS": "1",
    "TOKENIZERS_PARALLELISM": "false",
    "PYTHONUNBUFFERED": "1",
}


log = logging.getLogger("minibrain.worker")


class LeaseLostError(Exception):
    pass


class WorkerStoppedError(Exception):
    pass


class Response(Protocol):
    status_code: int
    text: str

    def raise_for_status(self) -> Any: ...

    def json(self) -> Any: ...

    def iter_bytes(self) -> Any: ...


class HttpClient(Protocol):
    def request(self, method: str, url: str, *, content: Any = ..., json: Any = ..., headers: Any = ...) -> Any: ...

    def stream(self, method: str, url: str, *, headers: Any = ...) -> AbstractContextManager[Any]: ...


@dataclass
class WorkerConfig:
    api_url: str
    token: str
    home: Path
    kinds: list[str] = field(default_factory=lambda: [str(kind) for kind in REMOTE_KINDS])
    gpus: int = 1
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    host: str = field(default_factory=platform.node)
    pool: str = LOCAL_POOL
    hardware: dict[str, Any] = field(default_factory=dict)
    models: Path | None = None
    prune: bool = True

    @property
    def models_dir(self) -> Path:
        return self.models or self.home / "models"


class MainClient:
    def __init__(self, config: WorkerConfig, http: HttpClient | None = None) -> None:
        self.config = config
        self.http: HttpClient = http or httpx.Client(base_url=config.api_url, timeout=httpx.Timeout(60.0, connect=10.0))
        self.headers = {"Authorization": f"Bearer {config.token}"}
        self.stop = threading.Event()

    def call(self, method: str, path: str, opener: Callable[[], Any] | None = None, **kwargs: Any) -> Response:
        delay = 1.0
        headers = self.headers | kwargs.pop("extra", {})
        for attempt in range(RETRIES):
            body = opener() if opener is not None else None
            try:
                response = self.http.request(method, path, headers=headers, content=body, **kwargs)
            except httpx.TransportError:
                if attempt == RETRIES - 1:
                    raise
            else:
                if response.status_code == 409:
                    raise LeaseLostError(response.text)
                if response.status_code < 500 or attempt == RETRIES - 1:
                    response.raise_for_status()
                    return response
            finally:
                if body is not None and hasattr(body, "close"):
                    body.close()
            if self.stop.wait(delay):
                raise WorkerStoppedError("worker is stopping")
            delay = min(delay * 2, 30.0)
        raise RuntimeError("unreachable")

    def worker_body(self) -> dict[str, Any]:
        config = self.config
        return {
            "id": config.id,
            "host": config.host,
            "kinds": config.kinds,
            "gpus": config.gpus,
            "pool": config.pool,
            "hardware": config.hardware,
        }

    def register(self) -> None:
        self.call("POST", "/internal/worker/register", json=self.worker_body())

    def claim(self, wait: float) -> dict[str, Any] | None:
        response = self.call("POST", "/internal/worker/claim", json={"worker": self.worker_body(), "wait": wait})
        return None if response.status_code == 204 else response.json()

    def heartbeat(self, job_id: int, token: str) -> dict[str, Any]:
        return self.call("POST", f"/internal/worker/jobs/{job_id}/heartbeat", json={"token": token}).json()

    def events(self, job_id: int, token: str, events: list[dict[str, Any]]) -> None:
        self.call("POST", f"/internal/worker/jobs/{job_id}/events", json={"token": token, "events": events})

    def complete(
        self, job_id: int, token: str, result: dict[str, Any], outputs: dict[str, str], log: str | None
    ) -> None:
        body = {"token": token, "result": result, "outputs": outputs, "log": log}
        self.call("POST", f"/internal/worker/jobs/{job_id}/complete", json=body)

    def fail(
        self, job_id: int, token: str, error: str, retryable: bool, log: str | None, code: str | None = None
    ) -> None:
        body = {"token": token, "error": error, "retryable": retryable, "log": log}
        self.call("POST", f"/internal/worker/jobs/{job_id}/fail", json=body | ({"code": code} if code else {}))

    def upload(self, store: ArtifactStore, artifact_id: str, kind: str, packing: str, name: str) -> str:
        headers = {"X-Artifact-Kind": kind, "X-Artifact-Packing": packing, "X-Artifact-Name": name}
        self.call(
            "PUT",
            f"/internal/worker/artifacts/{artifact_id}",
            opener=lambda: file_chunks(store.open(artifact_id)),
            extra=headers,
        )
        return artifact_id

    def upload_file(self, path: Path, artifact_id: str, name: str, replace: bool) -> None:
        headers = {"X-Artifact-Kind": WEIGHTS, "X-Artifact-Packing": Packing.FILE, "X-Artifact-Name": name}
        headers |= {"X-Artifact-Replace": "1"} if replace else {}
        self.call(
            "PUT",
            f"/internal/worker/artifacts/{artifact_id}",
            opener=lambda: file_chunks(path.open("rb")),
            extra=headers,
        )

    def stored(self, base_model_id: str) -> list[dict[str, Any]]:
        return list(self.call("GET", f"/internal/worker/bases/{base_model_id}/stored").json()["files"])

    def bases(self, key: str) -> dict[str, Any]:
        return dict(self.call("GET", f"/internal/worker/bases/{key}").json())

    def live_bases(self) -> dict[str, str | None]:
        return dict(self.call("GET", "/internal/worker/bases").json()["bases"])

    def download(self, store: ArtifactStore, artifact_id: str) -> None:
        if store.has(artifact_id):
            return
        with self.http.stream("GET", f"/internal/worker/artifacts/{artifact_id}", headers=self.headers) as response:
            response.raise_for_status()
            store.put_stream(StreamReader(response.iter_bytes()), expected=artifact_id)


def file_chunks(stream: BinaryIO) -> Iterator[bytes]:
    with stream:
        while chunk := stream.read(CHUNK):
            yield chunk


class Publisher:
    def __init__(self, client: MainClient, out: Path, replace: bool) -> None:
        self.client = client
        self.out = out
        self.replace = replace
        self.error: str | None = None
        self.queue: queue.Queue[dict[str, Any] | None] = queue.Queue()
        self.process: subprocess.Popen[bytes] | None = None
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def staged(self, line: dict[str, Any]) -> None:
        self.queue.put(line)

    def run(self) -> None:
        while (item := self.queue.get()) is not None:
            if self.error is not None:
                continue
            path = self.out / str(item["staged"])
            try:
                self.client.upload_file(path, str(item["sha256"]), str(item["staged"]), self.replace)
                path.unlink(missing_ok=True)
            except Exception as error:
                self.error = f"could not store {item['staged']} in the bucket: {type(error).__name__}: {error}"
                if self.process is not None:
                    stop_group(self.process)

    def finish(self) -> str | None:
        self.queue.put(None)
        self.thread.join()
        return self.error


class LineCollector:
    def __init__(self, stream: IO[bytes], log_path: Path, publisher: Publisher | None = None) -> None:
        self.stream = stream
        self.log_path = log_path
        self.publisher = publisher
        self.pending: list[dict[str, Any]] = []
        self.tail: list[str] = []
        self.lock = threading.Lock()
        self.thread = threading.Thread(target=self.pump, daemon=True)
        self.thread.start()

    def pump(self) -> None:
        with self.log_path.open("ab") as log:
            for raw in iter(self.stream.readline, b""):
                log.write(raw)
                log.flush()
                self.add(raw.decode(errors="replace").rstrip("\n"))

    def add(self, line: str) -> None:
        events: list[dict[str, Any]] = [{"kind": "log", "message": line}]
        parsed = parse_json(line)
        if parsed is not None and "progress" in parsed:
            events.append({"kind": "progress", "message": "", "data": parsed})
        if parsed is not None and "staged" in parsed and self.publisher is not None:
            self.publisher.staged(parsed)
        with self.lock:
            self.pending += events
            self.tail = [*self.tail, line][-50:]

    def drain(self) -> list[dict[str, Any]]:
        with self.lock:
            drained, self.pending = self.pending, []
        return drained


def parse_json(line: str) -> dict[str, Any] | None:
    if not line.startswith("{"):
        return None
    try:
        value = json.loads(line)
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def failure_from(tail: list[str], exit_code: int) -> tuple[str, bool, str | None]:
    for line in reversed(tail):
        parsed = parse_json(line)
        if parsed is not None and "error" in parsed:
            code = parsed.get("code")
            return str(parsed["error"]), bool(parsed.get("retryable", True)), str(code) if code else None
    return f"exited with code {exit_code}", exit_code != FINAL_EXIT, None


class Worker:
    def __init__(self, config: WorkerConfig, client: MainClient | None = None, modules: dict[str, str] | None = None):
        self.config = config
        self.client = client or MainClient(config)
        self.modules = modules or MODULES
        self.store = ArtifactStore(config.home / "artifacts", config.home / "cache")

    def run_forever(self, stop: threading.Event) -> None:
        configure_logging()
        self.client.stop = stop
        try:
            self.client.register()
            self.prune_copies()
            pruned = time.monotonic()
            while not stop.is_set():
                self.run_once(CLAIM_WAIT_SECONDS)
                if time.monotonic() - pruned > PRUNE_SECONDS:
                    self.prune_copies()
                    pruned = time.monotonic()
        except WorkerStoppedError:
            return

    def run_once(self, wait: float = 0.0) -> bool:
        claim = self.client.claim(wait)
        if claim is None:
            return False
        self.run(claim)
        return True

    def prune_copies(self) -> None:
        if not self.config.prune:
            return
        try:
            removed = prune(self.config.models_dir, self.client.live_bases(), lambda entry: entry)
        except Exception:
            log.warning("could not check this worker's model copies against main")
            return
        for key in removed:
            log.info("removed the working copy of %s; main no longer has that model", key)

    def base_copy(self, spec: dict[str, Any]) -> dict[str, Any]:
        if not spec.get("content_hash"):
            return spec
        listing = self.client.bases(str(spec["key"]))
        files, content = listing["files"], listing.get("content_hash")
        local = Path(spec["path"]) if spec.get("path") else None
        if listing.get("store") != BUCKET and local is not None and not size_problems(local, files):
            return spec
        if local is not None and matches(local, files, content):
            return spec
        folder = self.config.models_dir / str(spec["key"])
        files_url = f"/internal/worker/bases/{spec['key']}/files"
        with bucket_client() as bucket:
            relist = partial(self.client.bases, str(spec["key"]))
            opener = opener_for(listing, self.client.http, files_url, self.client.headers, bucket, relist)
            ensure(folder, files, opener, content)
        return spec | {"path": str(folder)}

    def secrets(self, claim: dict[str, Any]) -> bytes | None:
        params = claim["params"]
        if claim["kind"] != JobKind.VERIFY or params.get("store") != BUCKET:
            return None
        return json.dumps(self.client.bases(str(params["base_model_id"]))).encode()

    def publisher(self, claim: dict[str, Any]) -> Publisher | None:
        params = claim["params"]
        if claim["kind"] not in TRANSFER_KINDS or params.get("store") != BUCKET:
            return None
        return Publisher(self.client, Path(params["out"]), replace=claim["kind"] == JobKind.REPAIR)

    def material(self, ref: dict[str, Any] | None) -> str | None:
        if ref is None:
            return None
        self.client.download(self.store, ref["id"])
        return str(self.store.materialize(ref["id"], ref["packing"], ref["name"]))

    def spec(self, claim: dict[str, Any], workdir: Path, attempt_dir: Path) -> dict[str, Any]:
        params = claim["params"]
        spec: dict[str, Any] = {"result": str(attempt_dir / "result.json")}
        if claim["kind"] in TRANSFER_KINDS and params.get("store") == BUCKET:
            spec["stored"] = self.client.stored(str(params["base_model_id"]))
        if claim["kind"] in PASSTHROUGH_KINDS:
            return params | spec
        spec |= {key: params[key] for key in ("slug", "number", "base_model") if key in params}
        if "base_spec" in params:
            spec["base_spec"] = self.base_copy(params["base_spec"])
        spec["dataset_version"] = self.material(params.get("dataset_version"))
        if claim["kind"] == JobKind.TRAIN:
            spec |= {
                "recipe": params["recipe"],
                "plan_base": params.get("plan_base"),
                "prompting": params["prompting"],
                "adapter_out": str(attempt_dir / "out"),
                "checkpoints": str(workdir / "checkpoints"),
            }
        if claim["kind"] == JobKind.EVAL:
            spec |= {
                "version_kind": params["version_kind"],
                "adapter": self.material(params.get("adapter")),
                "prompting": params["prompting"],
                "answer_tokens": params.get("answer_tokens"),
                "pool": self.config.pool,
            }
        if claim["kind"] == JobKind.JUDGE:
            spec |= {key: params[key] for key in ("rubric", "items", "judge", "judge_version")}
        return spec

    def outputs(self, kind: str, attempt_dir: Path) -> dict[str, str]:
        names: dict[str, str] = {JobKind.TRAIN: "adapter"}
        if kind not in names:
            return {}
        stored = self.store.put_dir(attempt_dir / "out")
        return {names[kind]: self.client.upload(self.store, stored.id, names[kind], Packing.TAR, names[kind])}

    def upload_log(self, log_path: Path) -> str | None:
        if not log_path.exists():
            return None
        stored = self.store.put_file(log_path)
        return self.client.upload(self.store, stored.id, "log", Packing.FILE, "log.txt")

    def run(self, claim: dict[str, Any]) -> None:
        job_id, token, kind = claim["job_id"], claim["token"], claim["kind"]
        workdir = self.config.home / "work" / f"job-{job_id}"
        attempt_dir = workdir / f"attempt-{claim['attempt']}"
        shutil.rmtree(attempt_dir, ignore_errors=True)
        attempt_dir.mkdir(parents=True)
        log_path = attempt_dir / "log.txt"
        publisher: Publisher | None = None
        try:
            spec_path = attempt_dir / "spec.json"
            spec_path.write_text(json.dumps(self.spec(claim, workdir, attempt_dir)))
            arguments = [self.modules[kind], str(spec_path)]
            publisher = self.publisher(claim)
            exit_code, cancelled, tail = self.supervise(
                job_id, token, arguments, log_path, claim.get("env") or {}, publisher, self.secrets(claim)
            )
            stored_error = publisher.finish() if publisher is not None else None
            log = self.upload_log(log_path)
            if cancelled:
                self.client.fail(job_id, token, "cancelled", False, log)
            elif stored_error is not None:
                self.client.fail(job_id, token, stored_error, True, log)
            elif exit_code == 0:
                result = json.loads((attempt_dir / "result.json").read_text())
                self.client.complete(job_id, token, result, self.outputs(kind, attempt_dir), log)
                shutil.rmtree(workdir, ignore_errors=True)
            else:
                error, retryable, code = failure_from(tail, exit_code)
                self.client.fail(job_id, token, error, retryable, log, code)
        except LeaseLostError:
            return
        except Exception as error:
            self.client.fail(job_id, token, f"worker error: {type(error).__name__}: {error}", True, None)

    def supervise(
        self,
        job_id: int,
        token: str,
        arguments: list[str],
        log_path: Path,
        env: dict[str, str] | None = None,
        publisher: Publisher | None = None,
        secrets: bytes | None = None,
    ) -> tuple[int, bool, list[str]]:
        process = subprocess.Popen(
            [sys.executable, "-m", *arguments],
            stdin=subprocess.PIPE if secrets is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            env=os.environ | QUIET_ENV | (env or {}),
        )
        if process.stdout is None:
            raise RuntimeError("child has no stdout")
        if publisher is not None:
            publisher.process = process
        if secrets is not None and process.stdin is not None:
            with process.stdin:
                process.stdin.write(secrets)
        lines = LineCollector(process.stdout, log_path, publisher)
        cancelled = False
        last_flush = last_beat = time.monotonic()
        try:
            while process.poll() is None:
                time.sleep(0.2)
                moment = time.monotonic()
                if moment - last_flush >= FLUSH_SECONDS:
                    self.flush(job_id, token, lines)
                    last_flush = moment
                if moment - last_beat >= HEARTBEAT_SECONDS:
                    last_beat = moment
                    if self.client.heartbeat(job_id, token).get("cancel"):
                        cancelled = True
                        stop_group(process)
        except BaseException:
            stop_group(process)
            raise
        lines.thread.join(timeout=10)
        self.flush(job_id, token, lines)
        return process.returncode, cancelled, lines.tail

    def flush(self, job_id: int, token: str, lines: LineCollector) -> None:
        events = lines.drain()
        for start in range(0, len(events), 200):
            self.client.events(job_id, token, events[start : start + 200])


def stop_group(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=20)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    except ProcessLookupError:
        pass
