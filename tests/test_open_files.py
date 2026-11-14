import gc
from pathlib import Path

import psutil
from fastapi.testclient import TestClient

from minibrain.app import create_app
from minibrain.settings import Settings
from tests.conftest import FakeBackend


def files_under(folder: Path) -> list[str]:
    root = str(folder.resolve())
    return [found.path for found in psutil.Process().open_files() if found.path.startswith(root)]


def test_a_stopped_app_keeps_no_files_open(settings: Settings) -> None:
    settings.home.mkdir(parents=True)
    with TestClient(create_app(settings=settings, backend=FakeBackend(), background=False)) as client:
        assert client.get("/healthz").status_code == 200
        assert files_under(settings.home)
    assert files_under(settings.home) == []


def test_an_app_that_never_started_lets_its_files_go(settings: Settings) -> None:
    settings.home.mkdir(parents=True)
    app = create_app(settings=settings, backend=FakeBackend(), background=False)
    with app.state.sessions() as session:
        session.connection()
    del app, session
    gc.collect()
    assert files_under(settings.home) == []
