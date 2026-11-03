import base64
import hashlib
import io
import os
import stat
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fsspec.implementations.memory import MemoryFileSystem
from sqlalchemy import select

from minibrain import object_store
from minibrain.artifacts import ArtifactStore
from minibrain.connections import vault
from minibrain.encryption import envelope, keys, sealed
from minibrain.encryption.envelope import CHUNK, HEADER, TAG, EnvelopeError, Wrapped
from minibrain.encryption.providers import KeyFile, LocalKeys
from minibrain.registry.files import store_for
from minibrain.registry.models import Connection
from minibrain.settings import Settings
from tests.conftest import Harness, tickets_csv

SMALL = 64


class RingKeys:
    def __init__(self, ring: LocalKeys) -> None:
        self.ring = ring

    def sealing(self) -> bool:
        return True

    def wrap(self, key: bytes, context: bytes) -> Wrapped:
        return self.ring.wrap(key, context)

    def unwrap(self, wrapped: Wrapped, context: bytes) -> bytes:
        return self.ring.unwrap(wrapped, context)

    def is_current(self, wrapped: Wrapped) -> bool:
        return wrapped.key == self.ring.current()


@pytest.fixture
def ring(tmp_path: Path) -> RingKeys:
    return RingKeys(LocalKeys(KeyFile(tmp_path / "keys" / "master.key", mounted=False)))


def sealed_bytes(ring: RingKeys, data: bytes, context: bytes = b"ctx", chunk: int = SMALL) -> bytes:
    sink = io.BytesIO()
    sealed.seal_stream(io.BytesIO(data), sink, ring, lambda _digest: context, chunk)
    return sink.getvalue()


def opened(ring: RingKeys, blob: bytes, context: bytes = b"ctx") -> bytes:
    with sealed.open_reader(io.BytesIO(blob), ring, context) as stream:
        return stream.read()


@pytest.mark.parametrize("size", [0, 1, SMALL - 1, SMALL, SMALL + 1, 3 * SMALL, 5 * SMALL + 7])
def test_every_size_round_trips_and_streams(ring: RingKeys, size: int) -> None:
    data = os.urandom(size)
    blob = sealed_bytes(ring, data)
    chunks = max(1, -(-size // SMALL))
    assert len(blob) == HEADER + size + chunks * TAG
    assert size < 16 or data[:16] not in blob
    assert opened(ring, blob) == data
    header = envelope.parse_header(blob[:HEADER])
    key = sealed.unwrap_any(ring, header, b"ctx")
    streamed = b"".join(envelope.plain_chunks(io.BytesIO(blob[HEADER:]), envelope.open_chunks(header, key)))
    assert streamed == data


def test_random_reads_match_the_plaintext(ring: RingKeys) -> None:
    data = os.urandom(10 * SMALL + 5)
    with sealed.open_reader(io.BytesIO(sealed_bytes(ring, data)), ring, b"ctx") as stream:
        for start, length in ((0, 3), (SMALL - 2, 5), (3 * SMALL, SMALL * 2), (10 * SMALL, 100), (len(data) + 4, 9)):
            stream.seek(start)
            assert stream.read(length) == data[start : start + length]
        assert stream.seek(0, io.SEEK_END) == len(data)


def chunk_slices(blob: bytes) -> list[bytes]:
    body = blob[HEADER:]
    return [body[start : start + SMALL + TAG] for start in range(0, len(body), SMALL + TAG)]


def test_flipped_bytes_reordered_and_cut_files_are_refused(ring: RingKeys) -> None:
    data = os.urandom(4 * SMALL + 10)
    blob = sealed_bytes(ring, data)
    parts = chunk_slices(blob)
    flipped = bytearray(blob)
    flipped[HEADER + SMALL + 3] ^= 1
    reordered = blob[:HEADER] + parts[1] + parts[0] + b"".join(parts[2:])
    cut_at_chunk = blob[:HEADER] + b"".join(parts[:2])
    cut_inside = blob[: HEADER + SMALL + 5]
    extended = blob + parts[1]
    fixed = bytearray(blob)
    fixed[20] ^= 1
    for broken in (bytes(flipped), reordered, cut_at_chunk, cut_inside, extended, bytes(fixed)):
        with pytest.raises(EnvelopeError):
            opened(ring, broken)


def test_a_file_moved_to_another_name_does_not_open(ring: RingKeys) -> None:
    blob = sealed_bytes(ring, b"payroll", context=sealed.artifact_context("a" * 64))
    with pytest.raises(EnvelopeError):
        opened(ring, blob, context=sealed.artifact_context("b" * 64))


def test_plaintext_files_read_as_they_are(ring: RingKeys) -> None:
    assert opened(ring, b"text,label\nhello,greeting\n") == b"text,label\nhello,greeting\n"
    assert opened(ring, b"") == b""


def test_a_damaged_key_slot_falls_back_to_the_other(ring: RingKeys, tmp_path: Path) -> None:
    path = tmp_path / "blob"
    path.write_bytes(sealed_bytes(ring, b"x" * 300))
    with path.open("r+b") as handle:
        header = envelope.parse_header(handle.read(HEADER))
        key = sealed.unwrap_any(ring, header, b"ctx")
        envelope.rewrite_slot(handle, header, ring.wrap(key, b"ctx"))
    raw = bytearray(path.read_bytes())
    assert envelope.parse_header(bytes(raw[:HEADER])).newest.offset == envelope.SLOTS[1]
    raw[envelope.SLOTS[1] + 40] ^= 1
    with pytest.raises(EnvelopeError, match="key slots"):
        opened(ring, bytes(raw))


def artifact_files(root: Path) -> list[Path]:
    return [path for path in root.rglob("*") if path.is_file() and sealed_name(path)]


def sealed_name(path: Path) -> bool:
    return len(path.name) == 64 and path.parent.name == path.name[:2]


def test_uploads_snapshots_and_staging_are_encrypted_at_rest(harness: Harness) -> None:
    data = tickets_csv()
    source = harness.client.post("/api/sources", files={"file": ("tickets.csv", data, "text/csv")})
    assert source.status_code == 201, source.text
    harness.client.post("/api/datasets", json={"name": "Tickets", "source_id": source.json()["id"]})
    snapshot = harness.client.post("/api/datasets/tickets/snapshots")
    assert snapshot.status_code == 201, snapshot.text
    home = harness.settings.home
    files = artifact_files(home / "artifacts")
    assert len(files) == 2
    for path in files:
        assert envelope.is_sealed(path.read_bytes()[:HEADER])
        assert b"ticket 1 about" not in path.read_bytes()
    staged = list((home / "staging").rglob("staging.duckdb"))
    assert len(staged) == 1 and envelope.is_sealed(staged[0].read_bytes()[:HEADER])
    assert not [path for path in (home / "staging").rglob("*") if path.name.startswith(".building")]
    assert not (home / "cache").exists() or not any((home / "cache").rglob("*.parquet"))
    store = store_for(harness.settings)
    with store.open(hashlib.sha256(data).hexdigest()) as stream:
        assert stream.read() == data
    rows = harness.client.get(f"/api/sources/{source.json()['id']}/rows")
    assert rows.status_code == 200, rows.text
    assert "ticket 1 about" in rows.text
    key = home / "keys" / "master.key"
    assert stat.S_IMODE(key.stat().st_mode) == 0o600 and stat.S_IMODE(key.parent.stat().st_mode) == 0o700


def test_workers_get_plaintext_and_store_their_outputs_encrypted(harness: Harness) -> None:
    payload = b"adapter weights " * 1000
    artifact_id = harness.upload(payload, "adapter", "file", "adapter.bin")
    stored = store_for(harness.settings).path(artifact_id).read_bytes()
    assert envelope.is_sealed(stored) and payload[:64] not in stored
    downloaded = harness.client.get(
        f"/internal/worker/artifacts/{artifact_id}", headers={"Authorization": f"Bearer {harness.token}"}
    )
    assert downloaded.status_code == 200 and downloaded.content == payload


def test_files_written_before_encryption_stay_readable(harness: Harness) -> None:
    store = store_for(harness.settings)
    payload = b"legacy plaintext artifact"
    plain = ArtifactStore(store.root, store.cache)
    legacy = plain.put_stream(io.BytesIO(payload))
    assert store.path(legacy.id).read_bytes() == payload
    with store.open(legacy.id) as stream:
        assert stream.read() == payload
    assert store.materialize(legacy.id, "file", "log.txt").read_bytes() == payload


def test_turning_encryption_off_writes_plaintext_and_keeps_reading_sealed_files(harness: Harness) -> None:
    store = store_for(harness.settings)
    before = store.put_stream(io.BytesIO(b"sealed before"))
    changed = harness.client.put("/api/policies/encryption", json={"value": "off"})
    assert changed.status_code == 200, changed.text
    keys.keys_for(harness.settings).invalidate()
    after = store.put_stream(io.BytesIO(b"plain after"))
    assert store.path(after.id).read_bytes() == b"plain after"
    with store.open(before.id) as stream:
        assert stream.read() == b"sealed before"


def test_the_bucket_only_ever_holds_ciphertext(harness: Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    filesystem = MemoryFileSystem()
    MemoryFileSystem.store.clear()
    monkeypatch.setitem(object_store.FILESYSTEMS, object_store.S3, lambda _config, _secret: filesystem)
    body = {
        "kind": "s3",
        "endpoint": "https://minio.internal:9000",
        "bucket": "ml-artifacts",
        "prefix": "team-a",
        "region": "",
        "access_key": "AKIAEXAMPLE",
        "secret": "not-a-real-secret",
    }
    assert harness.client.put("/api/settings/storage", json=body).status_code == 200
    data = tickets_csv(50)
    assert harness.client.post("/api/sources", files={"file": ("tickets.csv", data, "text/csv")}).status_code == 201
    artifact_id = hashlib.sha256(data).hexdigest()
    key = f"ml-artifacts/team-a/artifacts/{artifact_id[:2]}/{artifact_id}"
    blob = filesystem.cat_file(key)
    assert envelope.is_sealed(blob) and b"ticket 1 about" not in blob
    store = store_for(harness.settings)
    assert not store.local(artifact_id)
    with store.open(artifact_id) as stream:
        assert stream.read() == data
    assert store.remote is not None and list(store.remote.ids()) == [artifact_id]
    MemoryFileSystem.store.clear()


def test_connection_secrets_use_the_same_key_and_old_ones_still_open(settings: Settings) -> None:
    settings.home.mkdir(parents=True)
    legacy_key = AESGCM.generate_key(bit_length=256)
    legacy_file = settings.home / "secrets" / "master.key"
    legacy_file.parent.mkdir()
    legacy_file.write_text(base64.b64encode(legacy_key).decode())
    nonce = os.urandom(12)
    old_token = (
        "aesgcm1:"
        + base64.b64encode(
            nonce + AESGCM(legacy_key).encrypt(nonce, b"old-password", b"minibrain.connection.1")
        ).decode()
    )
    assert vault.unseal(settings, old_token, "minibrain.connection.1") == "old-password"
    assert not legacy_file.exists()
    moved = (settings.home / "keys" / "master.key").read_text().strip()
    assert base64.b64decode(moved) == legacy_key
    fresh = vault.seal(settings, "new-password", "minibrain.connection.1")
    assert fresh.startswith("envelope1:") and vault.unseal(settings, fresh, "minibrain.connection.1") == "new-password"


def test_a_second_main_never_makes_its_own_key(harness: Harness) -> None:
    key = harness.settings.home / "keys" / "master.key"
    assert key.is_file()
    key.rename(key.with_name("elsewhere.key"))
    fresh = keys.Keys(harness.settings)
    with pytest.raises(Exception, match="not on this server"):
        fresh.target()
    assert not key.exists()


def test_connection_rows_hold_envelope_tokens(harness: Harness) -> None:
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
            "secret": "pg-password-1234",
        },
    )
    assert created.status_code == 201, created.text
    with harness.sessions() as session:
        row = session.scalars(select(Connection)).one()
        assert (row.secret or "").startswith("envelope1:") and "pg-password" not in (row.secret or "")


def test_chunk_size_is_one_mebibyte_by_default() -> None:
    assert CHUNK == 1 << 20
