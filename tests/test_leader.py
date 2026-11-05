import os
import threading
import time
import uuid
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

from minibrain import app as app_module
from minibrain.app import create_app, expire_forever
from minibrain.leader import AdvisoryLeader, SingleLeader, leader_for
from minibrain.settings import Settings
from tests.conftest import FakeBackend, Harness, sign_in

POSTGRES = os.environ.get("MINIBRAIN_TEST_POSTGRES_URL")
needs_postgres = pytest.mark.skipif(not POSTGRES, reason="set MINIBRAIN_TEST_POSTGRES_URL to run against Postgres")


class Toggle:
    def __init__(self, leading: bool) -> None:
        self.leading = leading

    def held(self) -> bool:
        return self.leading

    def describe(self) -> str:
        return "leader" if self.leading else "standby"


class CountingQueue:
    def __init__(self) -> None:
        self.calls = 0

    def expire(self) -> None:
        self.calls += 1


def run_briefly(leader: Toggle, monkeypatch: pytest.MonkeyPatch) -> int:
    monkeypatch.setattr(app_module, "EXPIRY_SECONDS", 0.01)
    queue, stop = CountingQueue(), threading.Event()
    thread = threading.Thread(target=expire_forever, args=(queue, stop, leader))
    thread.start()
    deadline = time.monotonic() + 5
    while queue.calls == 0 and leader.held() and time.monotonic() < deadline:
        stop.wait(0.01)
    stop.wait(0.1)
    stop.set()
    thread.join()
    return queue.calls


def test_sqlite_install_is_its_own_leader(harness: Harness) -> None:
    assert isinstance(leader_for(harness.settings.database_url), SingleLeader)
    assert harness.client.get("/api/system").json()["loops"] == "single"


def test_background_loops_run_only_on_the_leader(monkeypatch: pytest.MonkeyPatch) -> None:
    assert run_briefly(Toggle(True), monkeypatch) > 0
    assert run_briefly(Toggle(False), monkeypatch) == 0


@pytest.fixture
def postgres() -> Iterator[str]:
    assert POSTGRES is not None
    name = f"minibrain_{uuid.uuid4().hex[:8]}"
    admin = create_engine(POSTGRES, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.execute(text(f'create database "{name}"'))
    yield POSTGRES.rsplit("/", 1)[0] + f"/{name}"
    with admin.connect() as connection:
        connection.execute(text(f'drop database "{name}" with (force)'))
    admin.dispose()


@needs_postgres
def test_one_main_leads_and_another_takes_over(postgres: str) -> None:
    first, second = AdvisoryLeader(postgres, key=42), AdvisoryLeader(postgres, key=42)
    assert first.held() and not second.held()
    first.release()
    assert second.held() and not first.held()
    killer = create_engine(postgres, isolation_level="AUTOCOMMIT")
    with killer.connect() as connection:
        connection.execute(text("select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory'"))
    killer.dispose()
    assert not second.held()
    assert first.held() and first.describe() == "leader"
    first.release()


@needs_postgres
def test_two_mains_share_postgres_and_one_runs_the_loops(postgres: str, tmp_path: Path) -> None:
    def main(name: str) -> FastAPI:
        settings = Settings(home=tmp_path / name, web_dist=tmp_path / "web", database=postgres)
        settings.home.mkdir(parents=True)
        return create_app(settings=settings, backend=FakeBackend(), background=False)

    first, second = main("a"), main("b")
    with TestClient(first) as a, TestClient(second) as b:
        sign_in(first, a)
        sign_in(second, b)
        first.state.leader.held()
        second.state.leader.held()
        assert {a.get("/api/system").json()["loops"], b.get("/api/system").json()["loops"]} == {"leader", "standby"}
        assert a.get("/api/catalog").status_code == 200 and b.get("/api/models").status_code == 200
        first.state.leader.release()
        second.state.leader.release()
