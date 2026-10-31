import os
import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx

from minibrain.base_models import BaseModelSpec
from minibrain.ml.completion import Completion
from minibrain.serve.backend import CompletionRequest, EngineUnavailableError
from minibrain.serve.select import sglang_python
from minibrain.serve.weights import local_dir
from minibrain.supervise import Supervisor

STARTUP_SECONDS = 900.0
MAX_LORA_RANK = 64
MAX_LORAS_PER_BATCH = 8

Command = Callable[[BaseModelSpec, int], list[str]]


def launch_command(spec: BaseModelSpec, port: int) -> list[str]:
    return [
        sglang_python() or sys.executable,
        "-m",
        "sglang.launch_server",
        "--model-path",
        str(local_dir(spec)),
        "--host",
        "127.0.0.1",
        "--port",
        str(port),
        "--enable-lora",
        "--max-lora-rank",
        str(MAX_LORA_RANK),
        "--lora-target-modules",
        "all",
        "--max-loras-per-batch",
        str(MAX_LORAS_PER_BATCH),
    ]


class SglangBackend:
    def __init__(
        self,
        materialize: Callable[[dict[str, Any]], Path],
        command: Command = launch_command,
        startup_seconds: float = STARTUP_SECONDS,
    ) -> None:
        self.materialize = materialize
        self.command = command
        self.startup_seconds = startup_seconds
        self.servers: dict[str, tuple[str, Supervisor]] = {}
        self.adapters: dict[str, set[str]] = {}
        self.lock = threading.Lock()
        self.http = httpx.Client(timeout=httpx.Timeout(300.0, connect=5.0))

    def wait_healthy(self, url: str) -> None:
        deadline = time.monotonic() + self.startup_seconds
        while time.monotonic() < deadline:
            try:
                if self.http.get(f"{url}/health").status_code == 200:
                    return
            except httpx.TransportError:
                pass
            time.sleep(0.5)
        raise EngineUnavailableError(f"SGLang did not become healthy at {url}")

    def load(self, spec: BaseModelSpec) -> str:
        from minibrain.serve.engines import free_port

        with self.lock:
            found = self.servers.get(spec.key)
            if found is not None:
                return found[0]
            port = free_port()
            supervisor = Supervisor(f"sglang {spec.key}", self.command(spec, port), dict(os.environ))
            supervisor.start()
            url = f"http://127.0.0.1:{port}"
            self.servers[spec.key] = (url, supervisor)
            self.adapters[spec.key] = set()
        self.wait_healthy(url)
        return url

    def ensure_adapter(self, spec: BaseModelSpec, url: str, name: str, artifact: dict[str, Any]) -> None:
        with self.lock:
            if name in self.adapters[spec.key]:
                return
            body = {"lora_name": name, "lora_path": str(self.materialize(artifact))}
            self.http.post(f"{url}/load_lora_adapter", json=body).raise_for_status()
            self.adapters[spec.key].add(name)

    def complete(self, request: CompletionRequest) -> Completion:
        spec = request.base
        url = self.load(spec)
        body: dict[str, Any] = {
            "model": spec.key,
            "messages": request.messages,
            "max_tokens": request.max_tokens,
            "temperature": 0.0,
            "stop": list(spec.stop_tokens),
            "chat_template_kwargs": spec.template_kwargs,
        }
        if request.adapter is not None:
            self.ensure_adapter(spec, url, request.adapter.name, request.adapter.artifact)
            body["lora_path"] = request.adapter.name
        started = time.perf_counter()
        response = self.http.post(f"{url}/v1/chat/completions", json=body)
        response.raise_for_status()
        result = response.json()
        choice = result["choices"][0]
        usage = result.get("usage") or {}
        return Completion(
            text=str(choice["message"].get("content") or ""),
            prompt_tokens=int(usage.get("prompt_tokens", 0)),
            completion_tokens=int(usage.get("completion_tokens", 0)),
            stopped=choice.get("finish_reason") == "stop",
            seconds=time.perf_counter() - started,
        )

    def status(self) -> list[dict[str, Any]]:
        return [
            {"base_model": key, "device": "sglang", "adapters": sorted(self.adapters.get(key, set()))}
            for key in self.servers
        ]

    def close(self) -> None:
        for _, supervisor in self.servers.values():
            supervisor.shutdown()
