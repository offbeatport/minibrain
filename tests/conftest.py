import io
import os
import secrets
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
from minibrain.artifacts import ArtifactStore
from minibrain.auth.accounts import CSRF_HEADER, SESSION_COOKIE, create_local, csrf_for, find_local, start_session
from minibrain.auth.roles import Role
from minibrain.data.snapshot import read_split
from minibrain.jobs.queue import SqlJobQueue
from minibrain.ml.completion import Completion
from minibrain.registry.files import snapshot_location
from minibrain.registry.models import Job
from minibrain.serve.backend import CompletionRequest
from minibrain.settings import Settings
from minibrain.tasks.service import version_contract
from minibrain.worker import MainClient, Worker, WorkerConfig
from tests.fake_s3 import ACCESS_KEY, SECRET_KEY, FakeS3, fake_s3

LABELS = ("billing", "bug", "account", "feature")
ADMIN_EMAIL = "admin@example.com"
FOLDER = "folder"
BUCKET = "s3"
BOTH_STORES = "both_stores"


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", f"{BOTH_STORES}: run the test against the folder store and an S3 bucket")


def pytest_generate_tests(metafunc: pytest.Metafunc) -> None:
    if metafunc.definition.get_closest_marker(BOTH_STORES) and "store_kind" in metafunc.fixturenames:
        metafunc.parametrize("store_kind", [FOLDER, BUCKET])


@dataclass
class FakeBackend:
    output: str = "billing"
    requests: list[CompletionRequest] = field(default_factory=list)
    stopped: bool = True

    def complete(self, request: CompletionRequest) -> Completion:
        self.requests.append(request)
        return Completion(text=self.output, prompt_tokens=12, completion_tokens=2, stopped=self.stopped, seconds=0.01)

    def status(self) -> list[dict[str, Any]]:
        return []


def sign_in(app: FastAPI, client: TestClient, email: str = ADMIN_EMAIL, role: Role | None = Role.ADMIN) -> TestClient:
    with app.state.sessions() as session:
        user = find_local(session, email) or create_local(session, email, email.split("@")[0].title(), Role.VIEWER)
        user.role = role.value if role is not None else None
        row, token = start_session(session, user, None, "pytest")
        session.commit()
        subject = f"session:{row.token_hash}"
    client.cookies.set(SESSION_COOKIE, token)
    client.headers[CSRF_HEADER] = csrf_for(app.state.csrf_key, subject)
    return client


@dataclass
class Harness:
    app: FastAPI
    client: TestClient
    settings: Settings
    backend: FakeBackend
    sessions: sessionmaker[Session]
    store_kind: str = FOLDER

    @property
    def queue(self) -> SqlJobQueue:
        return self.app.state.queue

    @property
    def token(self) -> str:
        return self.settings.secret("worker_token")

    @property
    def gateway_headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.settings.secret('gateway_token')}"}

    def person(self, role: Role | None, email: str | None = None) -> TestClient:
        name = email or f"{role.value if role is not None else 'nobody'}@example.com"
        return sign_in(self.app, TestClient(self.app), name, role)

    def flush_logs(self) -> int:
        return self.app.state.request_logs.flush()

    def settle(self, rounds: int = 10) -> None:
        for _ in range(rounds):
            if not self.app.state.teardowns.run_once():
                return

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
        worker = {"id": worker_id, "host": "test", "kinds": kinds, "gpus": 1}
        body = {"worker": worker, "wait": 0}
        response = self.internal("/claim", body)
        return None if response.status_code == 204 else response.json()

    def upload(self, data: bytes, kind: str, packing: str, name: str) -> str:
        client = MainClient(self.worker_config(), http=self.client)
        worker = Worker(self.worker_config(), client=client)
        stored = worker.store.put_stream(io.BytesIO(data))
        return client.upload(worker.store, stored.id, kind, packing, name)


def wrong_label(expected: str, labels: tuple[str, ...]) -> str:
    return next(label for label in labels if label != expected)


def scored_answers(harness: Harness, job_id: int, accuracy: float) -> dict[str, list[str]]:
    with harness.sessions() as session:
        job = session.get(Job, job_id)
        version = job.version if job is not None else None
        if version is None or version.snapshot is None:
            raise RuntimeError(f"job {job_id} scores no version with data")
        location = snapshot_location(session, harness.app.state.store, version.snapshot)
        labels = version_contract(version).labels or LABELS
        splits = {name: read_split(location, name) for name in ("golden", "eval")}
    answers: dict[str, list[str]] = {}
    for name, rows in splits.items():
        right = round(len(rows) * accuracy)
        answers[name] = [
            row.expected if index < right else wrong_label(row.expected, labels) for index, row in enumerate(rows)
        ]
    return answers


def stored_bytes(store: ArtifactStore, artifact_id: str) -> bytes:
    with store.raw(artifact_id) as stream:
        return stream.read()


def tickets_csv(rows: int = 200) -> bytes:
    lines = ["text,category"]
    lines += [f"ticket {index} about {LABELS[index % 4]},{LABELS[index % 4]}" for index in range(rows)]
    return ("\n".join(lines) + "\n").encode()


def give_data(harness: "Harness", slug: str, data: bytes | None = None, name: str = "tickets.csv") -> dict[str, Any]:
    files = {"file": (name, data if data is not None else tickets_csv(), "text/csv")}
    source = harness.client.post("/api/sources", files=files).json()
    dataset = harness.client.post("/api/datasets", json={"name": slug, "source_id": source["id"]}).json()
    chosen = harness.client.put(f"/api/models/{slug}/dataset", json={"dataset": dataset["slug"]})
    chosen.raise_for_status()
    return chosen.json()


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
def store_kind() -> str:
    return FOLDER


@pytest.fixture(scope="session")
def moto() -> Iterator[FakeS3]:
    with fake_s3() as server:
        yield server


def storage_body(server: FakeS3, bucket: str) -> dict[str, Any]:
    return {
        "kind": BUCKET,
        "endpoint": server.endpoint,
        "bucket": bucket,
        "prefix": "minibrain",
        "region": "",
        "access_key": ACCESS_KEY,
        "secret": SECRET_KEY,
    }


def use_bucket(harness: Harness, server: FakeS3) -> str:
    bucket = f"minibrain-{secrets.token_hex(6)}"
    server.bucket(bucket)
    harness.client.put("/api/settings/storage", json=storage_body(server, bucket)).raise_for_status()
    if not harness.app.state.store.writes_remote:
        raise RuntimeError(f"storage did not switch to {bucket}")
    return bucket


@pytest.fixture
def harness(settings: Settings, store_kind: str, request: pytest.FixtureRequest) -> Iterator[Harness]:
    settings.home.mkdir(parents=True)
    backend = FakeBackend()
    app = create_app(settings=settings, backend=backend, background=False, config_max_age=0)
    with TestClient(app) as client:
        sign_in(app, client)
        found = Harness(
            app=app,
            client=client,
            settings=settings,
            backend=backend,
            sessions=app.state.sessions,
            store_kind=store_kind,
        )
        if store_kind == BUCKET:
            use_bucket(found, request.getfixturevalue("moto"))
        yield found
