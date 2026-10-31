import io
import os
import tarfile
import tempfile
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

os.environ["MINIBRAIN_HOME"] = tempfile.mkdtemp(prefix="minibrain-tests-")

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from minibrain.app import create_app
from minibrain.jobs.queue import SqlJobQueue
from minibrain.ml.completion import Completion
from minibrain.serve.backend import CompletionRequest
from minibrain.settings import Settings
from minibrain.worker import MainClient, Worker, WorkerConfig

LABELS = ("billing", "bug", "account", "feature")


@dataclass
class FakeBackend:
    output: str = "billing"
    requests: list[CompletionRequest] = field(default_factory=list)

    def complete(self, request: CompletionRequest) -> Completion:
        self.requests.append(request)
        return Completion(text=self.output, prompt_tokens=12, completion_tokens=2, stopped=True, seconds=0.01)


@dataclass
class Harness:
    app: FastAPI
    client: TestClient
    settings: Settings
    backend: FakeBackend
    sessions: sessionmaker[Session]

    @property
    def queue(self) -> SqlJobQueue:
        return self.app.state.queue

    @property
    def token(self) -> str:
        return self.settings.secret("worker_token")

    def worker_config(self, kinds: list[str] | None = None) -> WorkerConfig:
        config = WorkerConfig(api_url="http://testserver", token=self.token, home=self.settings.home / "worker")
        if kinds is not None:
            config.kinds = kinds
        return config

    def worker(self, kinds: list[str] | None = None, modules: dict[str, str] | None = None) -> Worker:
        config = self.worker_config(kinds)
        return Worker(config, client=MainClient(config, http=self.client), modules=modules)

    def internal(self, path: str, body: dict[str, Any]) -> Any:
        headers = {"Authorization": f"Bearer {self.token}"}
        return self.client.post(f"/internal/worker{path}", json=body, headers=headers)

    def claim(self, kinds: list[str], worker_id: str = "test-worker") -> dict[str, Any] | None:
        body = {"worker": {"id": worker_id, "host": "test", "kinds": kinds, "gpus": 1}, "wait": 0}
        response = self.internal("/claim", body)
        return None if response.status_code == 204 else response.json()

    def upload(self, data: bytes, kind: str, packing: str, name: str) -> str:
        client = MainClient(self.worker_config(), http=self.client)
        worker = Worker(self.worker_config(), client=client)
        stored = worker.store.put_stream(io.BytesIO(data))
        return client.upload(worker.store, stored.id, kind, packing, name)


def tickets_csv(rows: int = 200) -> bytes:
    lines = ["text,category"]
    lines += [f"ticket {index} about {LABELS[index % 4]},{LABELS[index % 4]}" for index in range(rows)]
    return ("\n".join(lines) + "\n").encode()


def fake_adapter() -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as archive:
        payload = b'{"r": 16}'
        info = tarfile.TarInfo("adapter_config.json")
        info.size = len(payload)
        archive.addfile(info, io.BytesIO(payload))
    return buffer.getvalue()


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(home=tmp_path / "home", web_dist=tmp_path / "web")


@pytest.fixture
def harness(settings: Settings) -> Iterator[Harness]:
    settings.home.mkdir(parents=True)
    backend = FakeBackend()
    app = create_app(settings=settings, backend=backend, run_expiry=False)
    with TestClient(app) as client:
        yield Harness(app=app, client=client, settings=settings, backend=backend, sessions=app.state.sessions)
