import os
import tempfile
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path

os.environ["MINIBRAIN_HOME"] = tempfile.mkdtemp(prefix="minibrain-tests-")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from minibrain.app import create_app
from minibrain.ml.completion import Completion
from minibrain.serve.backend import CompletionRequest
from minibrain.settings import Settings

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
    client: TestClient
    settings: Settings
    backend: FakeBackend
    queued: list[int]
    sessions: sessionmaker[Session]


def tickets_csv(rows: int = 200) -> bytes:
    lines = ["text,category"]
    lines += [f"ticket {index} about {LABELS[index % 4]},{LABELS[index % 4]}" for index in range(rows)]
    return ("\n".join(lines) + "\n").encode()


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(home=tmp_path / "home", web_dist=tmp_path / "web")


@pytest.fixture
def harness(settings: Settings) -> Iterator[Harness]:
    settings.home.mkdir(parents=True)
    backend = FakeBackend()
    queued: list[int] = []
    app = create_app(settings=settings, backend=backend, enqueue=queued.append)
    with TestClient(app) as client:
        yield Harness(client=client, settings=settings, backend=backend, queued=queued, sessions=app.state.sessions)
