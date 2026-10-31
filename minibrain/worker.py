import json
import os
import platform
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from collections.abc import Callable
from contextlib import AbstractContextManager
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO, Any, Protocol

import httpx

from minibrain.artifacts import ArtifactStore, Packing
from minibrain.ml.context import FINAL_EXIT
from minibrain.registry.models import JobKind

MODULES: dict[str, str] = {
    JobKind.PREPARE: "minibrain.data.prepare",
    JobKind.TRAIN: "minibrain.ml.train",
    JobKind.EVAL: "minibrain.ml.evaluate",
}
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


class LeaseLostError(Exception):
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
    kinds: list[str] = field(default_factory=lambda: list(MODULES))
    gpus: int = 1
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    host: str = field(default_factory=platform.node)


class MainClient:
    def __init__(self, config: WorkerConfig, http: HttpClient | None = None) -> None:
        self.config = config
        self.http: HttpClient = http or httpx.Client(base_url=config.api_url, timeout=httpx.Timeout(60.0, connect=10.0))
        self.headers = {"Authorization": f"Bearer {config.token}"}

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
            time.sleep(delay)
            delay = min(delay * 2, 30.0)
        raise RuntimeError("unreachable")

    def worker_body(self) -> dict[str, Any]:
        config = self.config
        return {"id": config.id, "host": config.host, "kinds": config.kinds, "gpus": config.gpus}

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

    def fail(self, job_id: int, token: str, error: str, retryable: bool, log: str | None) -> None:
        body = {"token": token, "error": error, "retryable": retryable, "log": log}
        self.call("POST", f"/internal/worker/jobs/{job_id}/fail", json=body)

    def upload(self, store: ArtifactStore, artifact_id: str, kind: str, packing: str, name: str) -> str:
        headers = {"X-Artifact-Kind": kind, "X-Artifact-Packing": packing, "X-Artifact-Name": name}
        self.call(
            "PUT", f"/internal/worker/artifacts/{artifact_id}", opener=lambda: store.open(artifact_id), extra=headers
        )
        return artifact_id

    def download(self, store: ArtifactStore, artifact_id: str) -> None:
        if store.has(artifact_id):
            return
        with self.http.stream("GET", f"/internal/worker/artifacts/{artifact_id}", headers=self.headers) as response:
            response.raise_for_status()
            store.put_stream(StreamReader(response.iter_bytes()), expected=artifact_id)


class StreamReader:
    def __init__(self, chunks: Any) -> None:
        self.chunks = iter(chunks)
        self.buffer = b""

    def read(self, size: int = -1) -> bytes:
        while size < 0 or len(self.buffer) < size:
            chunk = next(self.chunks, None)
            if chunk is None:
                break
            self.buffer += chunk
        if size < 0:
            data, self.buffer = self.buffer, b""
        else:
            data, self.buffer = self.buffer[:size], self.buffer[size:]
        return data


class LineCollector:
    def __init__(self, stream: IO[bytes], log_path: Path) -> None:
        self.stream = stream
        self.log_path = log_path
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


def failure_from(tail: list[str], exit_code: int) -> tuple[str, bool]:
    for line in reversed(tail):
        parsed = parse_json(line)
        if parsed is not None and "error" in parsed:
            return str(parsed["error"]), bool(parsed.get("retryable", True))
    return f"exited with code {exit_code}", exit_code != FINAL_EXIT


class Worker:
    def __init__(self, config: WorkerConfig, client: MainClient | None = None, modules: dict[str, str] | None = None):
        self.config = config
        self.client = client or MainClient(config)
        self.modules = modules or MODULES
        self.store = ArtifactStore(config.home / "artifacts", config.home / "cache")

    def run_forever(self, stop: threading.Event) -> None:
        self.client.register()
        while not stop.is_set():
            self.run_once(CLAIM_WAIT_SECONDS)

    def run_once(self, wait: float = 0.0) -> bool:
        claim = self.client.claim(wait)
        if claim is None:
            return False
        self.run(claim)
        return True

    def material(self, ref: dict[str, Any] | None) -> str | None:
        if ref is None:
            return None
        self.client.download(self.store, ref["id"])
        return str(self.store.materialize(ref["id"], ref["packing"], ref["name"]))

    def spec(self, claim: dict[str, Any], workdir: Path, attempt_dir: Path) -> dict[str, Any]:
        params = claim["params"]
        spec: dict[str, Any] = {"result": str(attempt_dir / "result.json")}
        if claim["kind"] == JobKind.PREPARE:
            spec |= {"source": self.material(params["source"]), "sql": params["sql"], "out": str(attempt_dir / "out")}
        else:
            spec |= {key: params[key] for key in ("slug", "number", "base_model") if key in params}
            spec["snapshot"] = self.material(params["snapshot"])
        if claim["kind"] == JobKind.TRAIN:
            spec |= {
                "recipe": params["recipe"],
                "adapter_out": str(attempt_dir / "out"),
                "checkpoints": str(workdir / "checkpoints"),
            }
        if claim["kind"] == JobKind.EVAL:
            spec |= {"version_kind": params["version_kind"], "adapter": self.material(params.get("adapter"))}
        return spec

    def outputs(self, kind: str, attempt_dir: Path) -> dict[str, str]:
        names: dict[str, str] = {JobKind.PREPARE: "snapshot", JobKind.TRAIN: "adapter"}
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
        try:
            spec_path = attempt_dir / "spec.json"
            spec_path.write_text(json.dumps(self.spec(claim, workdir, attempt_dir)))
            exit_code, cancelled, tail = self.supervise(job_id, token, [self.modules[kind], str(spec_path)], log_path)
            log = self.upload_log(log_path)
            if cancelled:
                self.client.fail(job_id, token, "cancelled", False, log)
            elif exit_code == 0:
                result = json.loads((attempt_dir / "result.json").read_text())
                self.client.complete(job_id, token, result, self.outputs(kind, attempt_dir), log)
                shutil.rmtree(workdir, ignore_errors=True)
            else:
                error, retryable = failure_from(tail, exit_code)
                self.client.fail(job_id, token, error, retryable, log)
        except LeaseLostError:
            return
        except Exception as error:
            self.client.fail(job_id, token, f"worker error: {type(error).__name__}: {error}", True, None)

    def supervise(self, job_id: int, token: str, arguments: list[str], log_path: Path) -> tuple[int, bool, list[str]]:
        process = subprocess.Popen(
            [sys.executable, "-m", *arguments],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            env=os.environ | QUIET_ENV,
        )
        if process.stdout is None:
            raise RuntimeError("child has no stdout")
        lines = LineCollector(process.stdout, log_path)
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
