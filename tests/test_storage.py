import stat
from collections.abc import Iterator
from typing import Any

import pytest
from fsspec.implementations.memory import MemoryFileSystem

from minibrain import object_store
from minibrain.registry.files import store_for
from tests.conftest import Harness, tickets_csv

BUCKET_KEY = "wJalrXUtnFEMI-not-a-real-key"
S3_BODY = {
    "kind": "s3",
    "endpoint": "https://minio.internal:9000",
    "bucket": "ml-artifacts",
    "prefix": "team-a",
    "region": "",
    "access_key": "AKIAEXAMPLE",
    "secret": BUCKET_KEY,
}


class BrokenFilesystem(MemoryFileSystem):
    def open(self, *_args: Any, **_kwargs: Any) -> Any:
        raise PermissionError("AccessDenied: no write access to ml-artifacts")


@pytest.fixture
def bucket(monkeypatch: pytest.MonkeyPatch) -> Iterator[MemoryFileSystem]:
    filesystem = MemoryFileSystem()
    MemoryFileSystem.store.clear()
    calls: list[tuple[str, str]] = []

    def fake(config: object_store.StorageConfig, secret: str) -> MemoryFileSystem:
        calls.append((config.endpoint, secret))
        return filesystem

    monkeypatch.setitem(object_store.FILESYSTEMS, object_store.S3, fake)
    yield filesystem
    MemoryFileSystem.store.clear()


def upload(harness: Harness) -> dict:
    response = harness.client.post("/api/sources", files={"file": ("tickets.csv", tickets_csv(), "text/csv")})
    assert response.status_code == 201, response.text
    return response.json()


def test_storage_starts_local_and_refuses_an_incomplete_bucket(harness: Harness, bucket: MemoryFileSystem) -> None:
    current = harness.client.get("/api/settings/storage").json()
    assert (current["kind"], current["secret_set"], current["prefix"]) == ("local", False, "minibrain")
    assert current["location"].endswith("artifacts")
    missing = harness.client.put("/api/settings/storage", json=S3_BODY | {"bucket": "", "secret": None})
    assert missing.status_code == 422 and "bucket, secret key" in missing.json()["detail"]
    bad = harness.client.put("/api/settings/storage", json=S3_BODY | {"endpoint": "minio.internal"})
    assert bad.status_code == 422 and "https://" in bad.json()["detail"]


def test_connection_check_writes_reads_and_removes_a_probe(
    harness: Harness, bucket: MemoryFileSystem, monkeypatch: pytest.MonkeyPatch
) -> None:
    checked = harness.client.post("/api/settings/storage/test", json=S3_BODY).json()
    assert checked["ok"] is True and "ml-artifacts" in checked["message"]
    assert bucket.find("ml-artifacts") == []
    monkeypatch.setitem(object_store.FILESYSTEMS, object_store.S3, lambda config, secret: BrokenFilesystem())
    failed = harness.client.post("/api/settings/storage/test", json=S3_BODY).json()
    assert failed["ok"] is False and "AccessDenied" in failed["message"]
    refused = harness.client.put("/api/settings/storage", json=S3_BODY)
    assert refused.status_code == 422
    assert harness.client.get("/api/settings/storage").json()["secret_set"] is False


def test_artifacts_go_to_the_bucket_and_the_secret_never_comes_back(harness: Harness, bucket: MemoryFileSystem) -> None:
    before = upload(harness)
    saved = harness.client.put("/api/settings/storage", json=S3_BODY)
    assert saved.status_code == 200, saved.text
    body = saved.json()
    assert (body["kind"], body["secret_set"], body["access_key"]) == ("s3", True, "AKIAEXAMPLE")
    assert body["location"] == "s3://ml-artifacts/team-a/artifacts at https://minio.internal:9000"
    assert BUCKET_KEY not in saved.text
    assert BUCKET_KEY not in harness.client.get("/api/settings/storage").text
    assert BUCKET_KEY not in harness.client.get("/api/audit").text
    secret_file = object_store.secret_path(harness.settings)
    assert secret_file.read_text() == BUCKET_KEY
    assert stat.S_IMODE(secret_file.stat().st_mode) == 0o600
    other = harness.client.post("/api/sources", files={"file": ("more.csv", tickets_csv(120), "text/csv")}).json()
    store = store_for(harness.settings)
    artifact_id = other_artifact(harness, other)
    assert any(name.endswith(f"/{artifact_id[:2]}/{artifact_id}") for name in bucket.find("ml-artifacts/team-a"))
    assert not store.local(artifact_id)
    assert harness.client.get(f"/api/sources/{other['id']}").json()["rows"] == 120
    assert harness.client.get(f"/api/sources/{before['id']}").json()["rows"] == 200
    harness.client.post("/api/datasets", json={"name": "More", "source_id": other["id"]})
    snapshot = harness.client.post("/api/datasets/more/snapshots").json()
    assert store.remote is not None and store.remote.has(snapshot["hash"])
    headers = {"Authorization": f"Bearer {harness.token}"}
    pulled = harness.client.get(f"/internal/worker/artifacts/{snapshot['hash']}", headers=headers)
    assert pulled.status_code == 200 and pulled.content[:4] == b"PAR1"
    stores = {item["name"]: item for item in harness.client.get("/api/system/infrastructure").json()["stores"]}
    assert stores["Snapshots"]["kind"] == "s3" and stores["Snapshots"]["free_bytes"] is None


def test_switching_back_to_local_keeps_bucket_artifacts_readable(harness: Harness, bucket: MemoryFileSystem) -> None:
    harness.client.put("/api/settings/storage", json=S3_BODY)
    remote = upload(harness)
    local = harness.client.put("/api/settings/storage", json=S3_BODY | {"kind": "local", "secret": None})
    assert local.json()["kind"] == "local" and local.json()["secret_set"] is True
    later = harness.client.post("/api/sources", files={"file": ("later.csv", tickets_csv(30), "text/csv")}).json()
    store = store_for(harness.settings)
    assert store.local(other_artifact(harness, later))
    assert harness.client.get(f"/api/sources/{remote['id']}").json()["rows"] == 200


def other_artifact(harness: Harness, source: dict) -> str:
    from minibrain.registry.models import Source

    with harness.sessions() as session:
        found = session.get(Source, source["id"])
        assert found is not None and found.artifact_id is not None
        return found.artifact_id
