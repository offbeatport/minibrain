import argparse
import json
import threading
import uuid
from collections.abc import Callable, Iterator
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from sqlalchemy import ColumnElement, create_engine, select, text, update
from sqlalchemy.orm import Session, sessionmaker

from minibrain import cli, maintenance
from minibrain.maintenance import purge_audit_events
from minibrain.registry.audit_chain import GENESIS, canonical, digest, head_of, seal, seal_all, verify, verify_records
from minibrain.registry.db import make_engine, make_sessions, migrate
from minibrain.registry.models import AuditEvent, now
from tests.conftest import Harness
from tests.test_audit import add_events
from tests.test_data_catalogue import migration_config
from tests.test_leader import POSTGRES, Toggle, needs_postgres


def sealed(harness: Harness) -> list[AuditEvent]:
    with harness.sessions() as session:
        seal_all(session)
        return list(session.scalars(select(AuditEvent).order_by(AuditEvent.seq)))


def report(harness: Harness) -> dict[str, Any]:
    response = harness.client.get("/api/audit/chain")
    assert response.status_code == 200, response.text
    return response.json()


def age(harness: Harness, days: int, *conditions: ColumnElement[bool]) -> None:
    with harness.sessions() as session:
        session.execute(update(AuditEvent).where(*conditions).values(at=now() - timedelta(days=days)))
        session.commit()


def run_sql(harness: Harness, statement: str, **params: Any) -> None:
    with harness.sessions() as session:
        session.execute(text(statement), params)
        session.commit()


def test_sealing_links_each_event_to_the_one_before(harness: Harness) -> None:
    add_events(harness, 3, detail={"name": "Support", "token": "sk-live-0123456789"})
    assert report(harness) | {"checked_at": None, "siem": None} == {
        "verified": True,
        "events": 0,
        "first_seq": None,
        "last_seq": 0,
        "anchor_seq": 0,
        "pending": 3,
        "broken": None,
        "checked_at": None,
        "siem": None,
    }
    events = sealed(harness)
    assert [event.seq for event in events] == [1, 2, 3]
    assert events[0].prev_hash == GENESIS
    assert [event.prev_hash for event in events[1:]] == [event.hash for event in events[:-1]]
    first = events[0]
    fields = {
        "action": "key.create",
        "actor": "Local user",
        "at": first.at.strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
        "detail": {"name": "Support", "token": "[redacted]"},
        "ip": None,
        "prev_hash": GENESIS,
        "seq": 1,
        "target": "mb_0000",
    }
    assert canonical(fields).startswith(b'{"action":"key.create","actor":"Local user","at":"')
    assert digest(fields) == first.hash
    with harness.sessions() as session:
        assert (head_of(session).seq, head_of(session).hash) == (3, events[-1].hash)
        assert seal(session) == 0
    found = report(harness)
    assert (found["verified"], found["events"], found["first_seq"], found["last_seq"], found["pending"]) == (
        True,
        3,
        1,
        3,
        0,
    )
    listed = harness.client.get("/api/audit").json()["events"][0]
    assert (listed["seq"], listed["prev_hash"], listed["hash"]) == (3, events[1].hash, events[2].hash)


def test_existing_events_are_chained_on_the_first_seal(tmp_path: Path) -> None:
    url = f"sqlite:///{tmp_path / 'old.db'}"
    engine = make_engine(url, foreign_keys=False)
    config = migration_config(engine)
    command.upgrade(config, "0030")
    with engine.begin() as connection:
        for target in ("first", "second"):
            connection.execute(
                text(
                    "INSERT INTO audit_events (at, actor, action, target, detail) "
                    "VALUES (CURRENT_TIMESTAMP, 'Local user', 'key.create', :target, '{}')"
                ),
                {"target": target},
            )
    command.upgrade(config, "0031")
    with engine.connect() as connection:
        assert connection.execute(text("SELECT seq, hash FROM audit_events")).all() == [(None, None), (None, None)]
        assert connection.execute(text("SELECT seq, hash, forwarded_seq FROM audit_chain")).all() == [(0, GENESIS, 0)]
    engine.dispose()
    with make_sessions(url)() as session:
        assert seal_all(session) == 2
        assert session.execute(select(AuditEvent.target, AuditEvent.seq).order_by(AuditEvent.id)).all() == [
            ("first", 1),
            ("second", 2),
        ]
        assert verify(session).verified
    command.downgrade(config, "0030")
    engine = make_engine(url, foreign_keys=False)
    with engine.connect() as connection:
        assert connection.execute(text("SELECT target FROM audit_events ORDER BY id")).scalars().all() == [
            "first",
            "second",
        ]
    engine.dispose()


FORGED = (
    "INSERT INTO audit_events (at, actor, action, target, detail, seq, prev_hash, hash) "
    "SELECT at, actor, action, 'forged', detail, 6, hash, hash FROM audit_events WHERE seq = 5"
)

TAMPERING: dict[str, tuple[str, int, int, str]] = {
    "edited detail": (
        'UPDATE audit_events SET detail = \'{"name": "other"}\' WHERE seq = 3',
        3,
        2,
        "its contents changed after it was sealed",
    ),
    "edited actor": ("UPDATE audit_events SET actor = 'Someone else' WHERE seq = 2", 2, 1, "its contents changed"),
    "rewritten hash": (
        "UPDATE audit_events SET hash = (SELECT hash FROM audit_events WHERE seq = 1) WHERE seq = 4",
        4,
        3,
        "its contents changed",
    ),
    "relinked event": ("UPDATE audit_events SET prev_hash = :genesis WHERE seq = 3", 3, 2, "does not match seq 2"),
    "deleted middle event": ("DELETE FROM audit_events WHERE seq = 3", 3, 2, "seq 3 is missing"),
    "renumbered event": ("UPDATE audit_events SET seq = 7 WHERE seq = 2", 2, 1, "seq 2 is missing"),
    "deleted oldest event": ("DELETE FROM audit_events WHERE seq = 1", 2, 0, "events before seq 2 were deleted"),
    "deleted newest events": ("DELETE FROM audit_events WHERE seq >= 4", 4, 3, "seq 4 to 5 are missing"),
    "forged event": (FORGED, 6, 5, "its contents changed"),
}


@pytest.mark.parametrize("case", list(TAMPERING))
def test_tampering_shows_as_the_first_break(harness: Harness, case: str) -> None:
    add_events(harness, 5)
    sealed(harness)
    assert report(harness)["verified"] is True
    statement, seq, last, reason = TAMPERING[case]
    run_sql(harness, statement, genesis=GENESIS)
    found = report(harness)
    assert found["verified"] is False
    assert (found["broken"]["seq"], found["last_seq"]) == (seq, last)
    assert reason in found["broken"]["reason"]


def test_events_chained_past_the_head_are_not_trusted(harness: Harness) -> None:
    add_events(harness, 2)
    newest = sealed(harness)[-1]
    with harness.sessions() as session:
        forged = AuditEvent(actor="Local user", action="key.revoke", target="mb_0001", detail={})
        session.add(forged)
        session.flush()
        forged.at = newest.at
        fields = {
            "seq": 3,
            "prev_hash": newest.hash,
            "at": newest.at.strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
            "actor": "Local user",
            "ip": None,
            "action": "key.revoke",
            "target": "mb_0001",
            "detail": {},
        }
        forged.seq, forged.prev_hash, forged.hash = 3, newest.hash, digest(fields)
        session.commit()
    found = report(harness)
    assert (found["verified"], found["broken"]["seq"], found["last_seq"]) == (False, 3, 3)
    assert found["broken"]["reason"] == "seq 3 was not sealed by minibrain"


def test_a_prune_anchors_the_chain_where_it_cuts(harness: Harness) -> None:
    add_events(harness, 4)
    with harness.sessions() as session:
        for event in session.scalars(select(AuditEvent).where(AuditEvent.target != "mb_0003")):
            event.at = now() - timedelta(days=100)
        session.add(AuditEvent(actor="Local user", action="key.create", target="unsealed", detail={}))
        session.commit()
        assert seal(session, limit=4) == 4
        cut_hash = session.scalars(select(AuditEvent.hash).where(AuditEvent.seq == 3)).one()
    age(harness, 200, AuditEvent.target == "unsealed")
    assert harness.client.put("/api/policies/audit_retention_days", json={"value": 90}).status_code == 200
    with harness.sessions() as session:
        assert purge_audit_events(session) == 3
        prune = session.scalars(select(AuditEvent).where(AuditEvent.action == "audit.prune")).one()
        assert (prune.detail["cut_seq"], prune.detail["cut_hash"], prune.detail["deleted"]) == (3, cut_hash, 3)
        assert prune.seq is None
    pending = report(harness)
    assert (pending["verified"], pending["anchor_seq"], pending["first_seq"], pending["pending"]) == (True, 3, 4, 3)
    remaining = sealed(harness)
    assert [event.target for event in remaining] == ["mb_0003", "unsealed", "audit_retention_days", "audit_events"]
    assert remaining[0].prev_hash == cut_hash
    after = report(harness)
    assert (after["verified"], after["anchor_seq"], after["first_seq"], after["last_seq"]) == (True, 3, 4, 7)
    with harness.sessions() as session:
        assert purge_audit_events(session) == 0
    run_sql(harness, "DELETE FROM audit_events WHERE action = 'audit.prune'")
    forged = report(harness)
    assert (forged["verified"], forged["broken"]["seq"]) == (False, 4)
    assert forged["broken"]["reason"] == "events before seq 4 were deleted without a prune"


def test_a_prune_of_every_sealed_event_still_verifies(harness: Harness) -> None:
    add_events(harness, 2)
    age(harness, 400)
    sealed(harness)
    assert harness.client.put("/api/policies/audit_retention_days", json={"value": 365}).status_code == 200
    with harness.sessions() as session:
        assert purge_audit_events(session) == 2
    found = report(harness)
    assert (found["verified"], found["events"], found["anchor_seq"], found["pending"]) == (True, 0, 2, 2)
    sealed(harness)
    after = report(harness)
    assert (after["verified"], after["first_seq"], after["last_seq"]) == (True, 3, 4)
    run_sql(harness, "DELETE FROM audit_events")
    gone = report(harness)
    assert (gone["verified"], gone["broken"]["reason"]) == (False, "seq 1 to 4 are missing")


def test_exports_carry_the_chain_and_verify_offline(harness: Harness, tmp_path: Path) -> None:
    add_events(harness, 3, detail={"name": "Ünïcode", "api_key": "sk-live-abcdef0123456789"})
    sealed(harness)
    lines = harness.client.get("/api/audit/export", params={"format": "jsonl"}).text.splitlines()
    records = [json.loads(line) for line in lines]
    assert [record["seq"] for record in records] == [3, 2, 1]
    assert all(len(record["hash"]) == 64 for record in records)
    assert verify_records(records).verified
    records[1]["detail"]["name"] = "Unicode"
    broken = verify_records(records)
    assert (broken.verified, broken.broken and broken.broken.seq) == (False, 2)
    export = tmp_path / "audit.jsonl"
    export.write_text("\n".join(lines) + "\n")
    cli.audit(argparse.Namespace(file=export, json=True))
    export.write_text("\n".join(json.dumps(record) for record in records))
    with pytest.raises(SystemExit):
        cli.audit(argparse.Namespace(file=export, json=False))


def test_cli_verifies_the_database(
    harness: Harness, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("MINIBRAIN_HOME", str(harness.settings.home))
    add_events(harness, 2)
    sealed(harness)
    add_events(harness, 1)
    cli.audit(argparse.Namespace(file=None, json=False))
    assert capsys.readouterr().out.strip() == (
        "Audit chain verified: 2 events, seq 1 to 2. 1 newer event is not sealed yet."
    )
    run_sql(harness, "UPDATE audit_events SET target = 'changed' WHERE seq = 2")
    with pytest.raises(SystemExit) as exit_code:
        cli.audit(argparse.Namespace(file=None, json=False))
    assert exit_code.value.code == 1
    assert capsys.readouterr().out.startswith("Audit chain broken at seq 2 (event 2): its contents changed")


def write_and_seal_concurrently(sessions: sessionmaker[Session], writers: int, each: int) -> list[BaseException]:
    errors: list[BaseException] = []
    done = threading.Event()

    def guarded(work: Callable[[], None]) -> Callable[[], None]:
        def run() -> None:
            try:
                work()
            except BaseException as error:
                errors.append(error)

        return run

    def write(index: int) -> None:
        for number in range(each):
            with sessions() as session:
                detail = {"writer": index, "number": number}
                session.add(AuditEvent(actor=f"writer {index}", action="key.create", target="t", detail=detail))
                session.commit()

    def keep_sealing() -> None:
        while not done.is_set():
            with sessions() as session:
                seal(session, limit=7)

    sealers = [threading.Thread(target=guarded(keep_sealing)) for _ in range(3)]
    threads = [threading.Thread(target=guarded(lambda index=index: write(index))) for index in range(writers)]
    for thread in [*sealers, *threads]:
        thread.start()
    for thread in threads:
        thread.join()
    done.set()
    for thread in sealers:
        thread.join()
    return errors


def check_concurrent_chain(url: str) -> None:
    migrate(url)
    sessions = make_sessions(url)
    writers, each = 6, 25
    assert write_and_seal_concurrently(sessions, writers, each) == []
    with sessions() as session:
        seal_all(session)
        seqs = session.scalars(select(AuditEvent.seq).order_by(AuditEvent.seq)).all()
        assert seqs == list(range(1, writers * each + 1))
        found = verify(session)
        assert (found.verified, found.events, found.pending) == (True, writers * each, 0)
        by_writer = session.execute(select(AuditEvent.detail).order_by(AuditEvent.seq)).scalars().all()
        for index in range(writers):
            assert [item["number"] for item in by_writer if item["writer"] == index] == list(range(each))


def test_concurrent_writers_and_sealers_keep_one_chain_on_sqlite(tmp_path: Path) -> None:
    check_concurrent_chain(f"sqlite:///{tmp_path / 'chain.db'}")


@pytest.fixture
def chain_postgres() -> Iterator[str]:
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
def test_concurrent_writers_and_sealers_keep_one_chain_on_postgres(chain_postgres: str) -> None:
    check_concurrent_chain(chain_postgres)


@needs_postgres
def test_an_event_that_commits_late_is_sealed_after_the_ones_that_beat_it(chain_postgres: str) -> None:
    migrate(chain_postgres)
    sessions = make_sessions(chain_postgres)
    with sessions() as slow, sessions() as fast:
        slow.add(AuditEvent(actor="slow", action="key.create", target="slow", detail={}))
        slow.flush()
        fast.add(AuditEvent(actor="fast", action="key.create", target="fast", detail={}))
        fast.commit()
        with sessions() as sealer:
            assert seal_all(sealer) == 1
        slow.commit()
    with sessions() as session:
        assert seal_all(session) == 1
        rows = session.execute(select(AuditEvent.target, AuditEvent.id, AuditEvent.seq).order_by(AuditEvent.seq)).all()
        assert [(row.target, row.seq) for row in rows] == [("fast", 1), ("slow", 2)]
        assert rows[0].id > rows[1].id
        assert verify(session).verified


def test_only_the_leader_seals(harness: Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(maintenance, "SEAL_SECONDS", 0.01)
    add_events(harness, 2)

    def run(leading: bool) -> int:
        stop = threading.Event()
        thread = threading.Thread(target=maintenance.seal_forever, args=(harness.sessions, stop, Toggle(leading)))
        thread.start()
        stop.wait(0.3)
        stop.set()
        thread.join()
        with harness.sessions() as session:
            return head_of(session).seq

    assert run(False) == 0
    assert run(True) == 2
