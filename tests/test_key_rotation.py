import base64
import hashlib
import io
import os
from datetime import timedelta
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fsspec.implementations.memory import MemoryFileSystem
from sqlalchemy import select

from minibrain import object_store
from minibrain.artifacts import ArtifactStore
from minibrain.connections import vault
from minibrain.encryption import envelope, keys, rekey
from minibrain.encryption.envelope import HEADER
from minibrain.registry.files import store_for
from minibrain.registry.models import AuditEvent, Connection
from minibrain.registry.settings_store import read
from tests.conftest import Harness, stored_bytes, tickets_csv


def legacy_store(harness: Harness) -> ArtifactStore:
    store = store_for(harness.settings)
    return ArtifactStore(store.root, store.cache)


def newest_key(path: Path) -> str:
    return header_key(path.read_bytes())


def header_key(blob: bytes) -> str:
    return envelope.parse_header(blob[:HEADER]).newest.wrapped.key


def run(harness: Harness, plan: rekey.Plan) -> rekey.Tally:
    with harness.sessions() as session:
        tally = rekey.run_pass(session, store_for(harness.settings), keys.keys_for(harness.settings), plan)
        session.commit()
    return tally


def test_encrypt_existing_seals_old_files_in_place_and_drops_plain_copies(harness: Harness) -> None:
    store = store_for(harness.settings)
    old = legacy_store(harness)
    payloads = [b"legacy snapshot rows " * 5000, b"", tickets_csv(30)]
    ids = [old.put_stream(io.BytesIO(payload)).id for payload in payloads]
    damaged = hashlib.sha256(b"something else").hexdigest()
    (store.root / damaged[:2]).mkdir(parents=True, exist_ok=True)
    (store.root / damaged[:2] / damaged).write_bytes(b"not what the name says")
    staged = harness.settings.home / "staging" / "abc.csv" / "staging.duckdb"
    staged.parent.mkdir(parents=True)
    staged.write_bytes(b"plain staging database")
    (staged.parent / "staging.duckdb.wal").write_bytes(b"plain wal")
    cached = store.cache / ids[0]
    cached.mkdir(parents=True)
    (cached / "snapshot.parquet").write_bytes(payloads[0])
    before = run(harness, rekey.Plan())
    assert (before.plain, before.damaged) == (5, 0)
    tally = run(harness, rekey.Plan(encrypt=True))
    assert (tally.encrypted, tally.damaged, tally.removed) == (4, 1, 2)
    assert damaged in tally.problems[0]
    for artifact_id, payload in zip(ids, payloads, strict=True):
        assert envelope.is_sealed(store.path(artifact_id).read_bytes())
        with store.open(artifact_id) as stream:
            assert stream.read() == payload
    assert (store.root / damaged[:2] / damaged).read_bytes() == b"not what the name says"
    assert envelope.is_sealed(staged.read_bytes()) and not (staged.parent / "staging.duckdb.wal").exists()
    with store.open_staged("abc.csv/staging.duckdb") as stream:
        assert stream.read() == b"plain staging database"
    assert not cached.exists()
    again = run(harness, rekey.Plan(encrypt=True))
    assert (again.encrypted, again.current, again.plain) == (0, 4, 0)


def legacy_token(key: bytes, plaintext: str, context: str) -> str:
    nonce = os.urandom(12)
    return (
        "aesgcm1:" + base64.b64encode(nonce + AESGCM(key).encrypt(nonce, plaintext.encode(), context.encode())).decode()
    )


def test_old_connection_secrets_move_to_the_envelope_format(harness: Harness) -> None:
    created = harness.client.post(
        "/api/connections",
        json={
            "name": "Warehouse",
            "kind": "postgres",
            "host": "db.internal",
            "port": 5432,
            "database": "analytics",
            "user": "ro",
            "ssl_mode": "require",
            "secret": "first-password",
        },
    )
    assert created.status_code == 201, created.text
    ring = keys.keys_for(harness.settings).local_ring()
    assert ring is not None
    with harness.sessions() as session:
        row = session.scalars(select(Connection)).one()
        row.secret = legacy_token(ring.legacy_keys()[0], "old-password", f"minibrain.connection.{row.id}")
        session.commit()
    tally = run(harness, rekey.Plan(encrypt=True))
    assert (tally.secrets, tally.resealed, tally.secrets_older) == (1, 1, 0)
    with harness.sessions() as session:
        row = session.scalars(select(Connection)).one()
        assert (row.secret or "").startswith("envelope1:")
        assert vault.unseal(harness.settings, row.secret or "", f"minibrain.connection.{row.id}") == "old-password"


@pytest.mark.both_stores
def test_rotation_rewraps_every_header_and_leaves_the_bodies_alone(harness: Harness) -> None:
    store = store_for(harness.settings)
    payload = os.urandom(3 * (1 << 20) + 5)
    first = store.put_stream(io.BytesIO(payload)).id
    second = store.put_stream(io.BytesIO(b"small")).id
    body = stored_bytes(store, first)[HEADER:]
    service = keys.keys_for(harness.settings)
    old = service.target().current()
    with harness.sessions() as session:
        before, after, note = rekey.rotate_key(session, service, "tester")
        session.commit()
    assert (before, note) == (old, "") and after != old
    with store.open(first) as stream:
        assert stream.read() == payload
    tally = run(harness, rekey.Plan(rewrap=True))
    assert (tally.rewrapped, tally.older, tally.current) == (2, 0, 2)
    assert stored_bytes(store, first)[HEADER:] == body
    assert header_key(stored_bytes(store, first)) == after == header_key(stored_bytes(store, second))
    ring = service.local_ring()
    assert ring is not None and ring.known() == [old, after]
    with harness.sessions() as session:
        assert rekey.retire_unused(session, service, tally, rekey.GRACE, "tester") == []
        assert rekey.retire_unused(session, service, tally, timedelta(0), "tester") == [f"local:{old}"]
        session.commit()
        retired = [item for item in keys.records_of(session) if item.get("retired_at")]
        actions = [event.action for event in session.scalars(select(AuditEvent))]
    assert [item["key"] for item in retired] == [old]
    assert {"encryption.rotate", "encryption.retire"} <= set(actions)
    assert ring.known() == [after]
    with store.open(first) as stream:
        assert stream.read() == payload


@pytest.mark.both_stores
def test_rotation_sends_only_the_header_of_a_large_object(harness: Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    store = store_for(harness.settings)
    payload = os.urandom(13 * (1 << 20) + 7)
    artifact_id = store.put_stream(io.BytesIO(payload)).id
    body = stored_bytes(store, artifact_id)[HEADER:]
    service = keys.keys_for(harness.settings)
    with harness.sessions() as session:
        _, after, _ = rekey.rotate_key(session, service, "tester")
        session.commit()
    calls: list[tuple[str, int]] = []
    bucket = store.remote
    if bucket is not None:
        assert isinstance(bucket, object_store.BucketBlobs)
        monkeypatch.setattr(object_store, "COPY_PART", 5 * (1 << 20))
        filesystem = bucket.fs
        call = filesystem.call_s3

        def counted(method: str, *args: object, **kwargs: object) -> object:
            sent = kwargs.get("Body")
            calls.append((method, len(sent) if isinstance(sent, bytes) else 0))
            return call(method, *args, **kwargs)

        monkeypatch.setattr(filesystem, "call_s3", counted)
        monkeypatch.setattr(bucket, "replace", lambda *_args: pytest.fail("the bucket object was sent whole"))
    tally = run(harness, rekey.Plan(rewrap=True))
    assert (tally.rewrapped, tally.older) == (1, 0)
    assert stored_bytes(store, artifact_id)[HEADER:] == body
    assert header_key(stored_bytes(store, artifact_id)) == after
    with store.open(artifact_id) as stream:
        assert stream.read() == payload
    if bucket is not None:
        sent = [(method, size) for method, size in calls if method != "head_object"]
        assert sent == [
            ("create_multipart_upload", 0),
            ("upload_part", object_store.FIRST_PART),
            ("upload_part_copy", 0),
            ("upload_part_copy", 0),
            ("complete_multipart_upload", 0),
        ]


def test_a_mounted_key_rotates_by_adding_a_line(
    harness: Harness, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mounted = tmp_path / "run" / "master.key"
    mounted.parent.mkdir()
    first_key = base64.b64encode(os.urandom(32)).decode()
    mounted.write_text(first_key + "\n")
    monkeypatch.setenv(keys.KEY_ENV, str(mounted))
    service = keys.Keys(harness.settings)
    service.attach(harness.sessions)
    store = ArtifactStore(harness.settings.home / "mounted", harness.settings.home / "mounted-cache", service)
    stored = store.put_stream(io.BytesIO(b"rows")).id
    old = newest_key(store.path(stored))
    with harness.sessions() as session:
        before, after, note = rekey.rotate_key(session, service, "tester")
        session.commit()
    assert before == after == old and "add a new key" in note
    mounted.write_text(first_key + "\n" + base64.b64encode(os.urandom(32)).decode() + "\n")
    with harness.sessions() as session:
        tally = rekey.run_pass(session, store, service, rekey.Plan(rewrap=True))
        assert f"local:{old}" in rekey.retire_unused(session, service, tally, timedelta(0), "tester")
    assert tally.rewrapped == 1 and newest_key(store.path(stored)) != old
    assert len(mounted.read_text().split()) == 2
    with store.open(stored) as stream:
        assert stream.read() == b"rows"


def test_the_bucket_is_encrypted_and_rotated_in_place(harness: Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    filesystem = MemoryFileSystem()
    MemoryFileSystem.store.clear()
    monkeypatch.setitem(object_store.FILESYSTEMS, object_store.S3, lambda _config, _secret: filesystem)
    body = {
        "kind": "s3",
        "endpoint": "https://minio.internal:9000",
        "bucket": "ml-artifacts",
        "prefix": "",
        "region": "",
        "access_key": "AKIAEXAMPLE",
        "secret": "not-a-real-secret",
    }
    assert harness.client.put("/api/settings/storage", json=body).status_code == 200
    plain = tickets_csv(40)
    artifact_id = hashlib.sha256(plain).hexdigest()
    key = f"ml-artifacts/artifacts/{artifact_id[:2]}/{artifact_id}"
    filesystem.pipe_file(key, plain)
    tally = run(harness, rekey.Plan(encrypt=True))
    assert tally.encrypted == 1 and envelope.is_sealed(filesystem.cat_file(key))
    service = keys.keys_for(harness.settings)
    with harness.sessions() as session:
        _, after, _ = rekey.rotate_key(session, service, "tester")
        session.commit()
    rotated = run(harness, rekey.Plan(rewrap=True))
    assert rotated.rewrapped == 1
    assert envelope.parse_header(filesystem.cat_file(key)[:HEADER]).newest.wrapped.key == after
    with store_for(harness.settings).open(artifact_id) as stream:
        assert stream.read() == plain
    MemoryFileSystem.store.clear()


def test_the_leader_runs_requested_passes_and_records_them(harness: Harness) -> None:
    old = legacy_store(harness)
    stored = old.put_stream(io.BytesIO(b"old rows")).id
    with harness.sessions() as session:
        task = rekey.request(session, rekey.ENCRYPT, "admin@example.com")
        session.commit()
        with pytest.raises(keys.EncryptionError, match="already queued"):
            rekey.request(session, rekey.CHECK, "admin@example.com")
    store = store_for(harness.settings)
    tally = rekey.execute(harness.sessions, store, keys.keys_for(harness.settings), task)
    assert tally.encrypted == 1 and envelope.is_sealed(store.path(stored).read_bytes())
    with harness.sessions() as session:
        finished = read(session, rekey.TASK)
        last = read(session, rekey.LAST)
        events = [event for event in session.scalars(select(AuditEvent)) if event.action.startswith("encryption.")]
    assert finished["state"] == rekey.DONE and last["tally"]["encrypted"] == 1
    assert [(event.action, event.actor) for event in events] == [("encryption.encrypt_existing", "admin@example.com")]


def test_settings_show_the_key_counts_and_queue_passes(harness: Harness) -> None:
    old = legacy_store(harness)
    old.put_stream(io.BytesIO(b"old rows"))
    queued = harness.client.post("/api/settings/encryption/tasks", json={"kind": "encrypt"})
    assert queued.status_code == 200, queued.text
    assert queued.json()["task"]["state"] == rekey.QUEUED
    assert harness.client.post("/api/settings/encryption/tasks", json={"kind": "check"}).status_code == 422
    task = rekey.pending(harness.sessions)
    assert task is not None
    rekey.execute(harness.sessions, store_for(harness.settings), keys.keys_for(harness.settings), task)
    status = harness.client.get("/api/settings/encryption").json()
    assert (status["provider"], status["task"]["state"]) == ("local", rekey.DONE)
    assert (status["last"]["counts"]["encrypted"], status["last"]["counts"]["plain"]) == (1, 0)
    current = [key for key in status["keys"] if key["current"]]
    assert len(current) == 1 and current[0]["files"] == 1 and current[0]["key"] == status["key"]
    assert status["fields"][0]["name"] == "encryption"
