import base64
import hashlib
import json
from dataclasses import replace
from pathlib import Path
from typing import Any

import httpx
import pytest

from minibrain.encryption import envelope
from minibrain.encryption.envelope import HEADER
from minibrain.models.bucket import WEIGHTS
from minibrain.models.copies import MANIFEST, bucket_chunks, read_manifest
from minibrain.registry.models import Artifact, AuditEvent, Model
from minibrain.serve.engine import local_copy, prune_engines, pull_base
from minibrain.storage import GIB, Space
from tests.conftest import BUCKET, FOLDER, Harness, use_bucket
from tests.fake_s3 import FakeS3
from tests.test_models import FILES, add_tiny, download_tiny, hub, manifest

FIXTURES = (hub,)
SHA = {entry["path"]: entry["sha256"] for entry in manifest()}
WEIGHTS_FILE = "model.safetensors"


def bucket_of(harness: Harness) -> str:
    return harness.client.get("/api/settings/storage").json()["bucket"]


def object_key(sha: str) -> str:
    return f"minibrain/artifacts/{sha[:2]}/{sha}"


def blob(moto: FakeS3, harness: Harness, sha: str) -> bytes:
    return moto.client.get_object(Bucket=bucket_of(harness), Key=object_key(sha))["Body"].read()


def in_bucket(moto: FakeS3, harness: Harness, sha: str) -> bool:
    listed = moto.client.list_objects_v2(Bucket=bucket_of(harness), Prefix=object_key(sha))
    return bool(listed.get("KeyCount"))


def installed(harness: Harness) -> dict[str, Any]:
    add_tiny(harness)
    download_tiny(harness)
    assert harness.worker(kinds=["download"]).run_once()
    return harness.client.get("/api/models/base/tiny").json()


def listing(harness: Harness) -> Any:
    return harness.client.get("/internal/gateway/bases/tiny", headers=harness.gateway_headers)


def gateway_token(harness: Harness) -> str:
    return harness.settings.secret("gateway_token")


@pytest.mark.parametrize("store_kind", [BUCKET])
@pytest.mark.usefixtures("hub")
def test_a_download_goes_to_the_bucket_encrypted_and_leaves_nothing_on_main(harness: Harness, moto: FakeS3) -> None:
    detail = installed(harness)
    assert (detail["store"], detail["store_label"]) == ("s3", f"S3 · {bucket_of(harness)}")
    assert {entry["state"] for entry in detail["files"]} == {"ok"}
    for name, data in FILES.items():
        stored = blob(moto, harness, SHA[name])
        assert envelope.is_sealed(stored[:HEADER]) and data not in stored
    assert not Path(detail["storage_path"]).exists()
    assert not (harness.settings.work_dir() / "models" / "tiny").exists()
    assert not list((harness.settings.artifacts_dir() / ".incoming").iterdir())
    with harness.sessions() as session:
        kinds = {artifact.kind for artifact in session.query(Artifact).filter(Artifact.id.in_(SHA.values()))}
        assert kinds == {WEIGHTS}
    catalog = harness.client.get("/api/catalog").json()
    assert (catalog["store_kind"], catalog["store_label"]) == ("s3", f"S3 · {bucket_of(harness)}")
    assert catalog["store_free_bytes"] is None and catalog["staging_free_bytes"] > 0
    stores = {item["name"]: item for item in harness.client.get("/api/system/infrastructure").json()["stores"]}
    assert stores["Model files"]["kind"] == "s3" and stores["Model files"]["used_bytes"] == detail["size_bytes"]
    assert harness.client.get("/api/models").json()[0]["health"] is None


@pytest.mark.parametrize("store_kind", [BUCKET])
@pytest.mark.usefixtures("hub")
def test_machines_fetch_from_the_bucket_with_signed_links_and_check_every_file(
    harness: Harness, moto: FakeS3, tmp_path: Path
) -> None:
    installed(harness)
    response = listing(harness)
    found = response.json()
    assert response.headers["cache-control"] == "no-store" and found["store"] == "s3"
    assert all(entry["url"].startswith(f"{moto.endpoint}/") and entry["key"] for entry in found["files"])
    assert all("X-Amz-Algorithm=AWS4-HMAC-SHA256" in entry["url"] for entry in found["files"])
    via_main = harness.client.get("/internal/gateway/bases/tiny/files/config.json", headers=harness.gateway_headers)
    assert via_main.status_code == 404
    spec = pull_base(harness.client, gateway_token(harness), "tiny", tmp_path / "engine" / "weights")
    assert all((tmp_path / "engine" / "weights" / name).read_bytes() == data for name, data in FILES.items())
    copy = read_manifest(tmp_path / "engine" / "weights")
    assert copy["working_copy"] and copy["content_hash"] == spec.content_hash
    worker = harness.worker(kinds=["train"])
    base = harness.client.get("/api/models/base/tiny").json()
    shaped = worker.base_copy({"key": "tiny", "path": base["storage_path"], "content_hash": spec.content_hash})
    assert Path(shaped["path"]) == harness.settings.home / "worker" / "models" / "tiny"
    assert (Path(shaped["path"]) / WEIGHTS_FILE).read_bytes() == FILES[WEIGHTS_FILE]
    local_copy(harness.client, gateway_token(harness), replace(spec, path=base["storage_path"]))
    assert (Path(base["storage_path"]) / WEIGHTS_FILE).read_bytes() == FILES[WEIGHTS_FILE]
    assert harness.client.get("/api/models/base/tiny").json()["store"] == "s3"
    damaged = found["files"][0] | {"key": base64.b64encode(b"\0" * 32).decode()}
    with httpx.Client() as http, pytest.raises(envelope.EnvelopeError), bucket_chunks(http, damaged) as chunks:
        b"".join(chunks)


@pytest.mark.parametrize("store_kind", [BUCKET])
@pytest.mark.usefixtures("hub")
def test_stale_working_copies_are_fetched_again_and_deleted_with_the_model(
    harness: Harness, moto: FakeS3, tmp_path: Path
) -> None:
    installed(harness)
    engines = tmp_path / "engines"
    weights = engines / "tiny" / "weights"
    token = gateway_token(harness)
    pull_base(harness.client, token, "tiny", weights)
    (weights / WEIGHTS_FILE).write_bytes(b"short")
    pull_base(harness.client, token, "tiny", weights)
    assert (weights / WEIGHTS_FILE).read_bytes() == FILES[WEIGHTS_FILE]
    record = json.loads((weights / MANIFEST).read_text())
    (weights / MANIFEST).write_text(json.dumps(record | {"content_hash": "0" * 64}))
    (weights / "leftover.safetensors").write_bytes(b"old")
    pull_base(harness.client, token, "tiny", weights)
    assert not (weights / "leftover.safetensors").exists() and (weights / WEIGHTS_FILE).is_file()
    assert prune_engines(harness.client, token, engines) == []
    assert harness.client.delete("/api/models/base/tiny").status_code == 202
    harness.settle()
    assert not any(in_bucket(moto, harness, sha) for sha in SHA.values())
    with harness.sessions() as session:
        assert session.query(Artifact).filter(Artifact.kind == WEIGHTS).count() == 0
        finished = session.query(AuditEvent).filter(AuditEvent.action == "model.delete_finished").one()
        assert finished.detail["removed"]["bucket_objects"] == len(FILES)
    assert prune_engines(harness.client, token, engines) == ["tiny"] and not weights.exists()


@pytest.mark.parametrize("store_kind", [BUCKET])
@pytest.mark.usefixtures("hub")
def test_verify_reads_the_bucket_and_repair_replaces_a_damaged_object(harness: Harness, moto: FakeS3) -> None:
    installed(harness)
    moto.put(bucket_of(harness), object_key(SHA[WEIGHTS_FILE]), b"x" * 9000)
    assert harness.client.post("/api/models/base/tiny/verify").status_code == 202
    assert harness.worker(kinds=["verify"]).run_once()
    row = next(item for item in harness.client.get("/api/models").json() if item["key"] == "tiny")
    assert row["health"]["state"] == "corrupt" and row["health"]["files"] == [WEIGHTS_FILE]
    assert harness.client.post("/api/models/base/tiny/repair").status_code == 202
    assert harness.worker(kinds=["repair"]).run_once()
    assert envelope.is_sealed(blob(moto, harness, SHA[WEIGHTS_FILE])[:HEADER])
    assert harness.client.post("/api/models/base/tiny/verify").status_code == 202
    assert harness.worker(kinds=["verify"]).run_once()
    row = next(item for item in harness.client.get("/api/models").json() if item["key"] == "tiny")
    assert row["health"] is None


@pytest.mark.parametrize("store_kind", [FOLDER])
@pytest.mark.usefixtures("hub")
def test_models_on_main_are_copied_to_the_bucket_and_stay_usable(harness: Harness, moto: FakeS3) -> None:
    detail = installed(harness)
    folder = Path(detail["storage_path"])
    assert detail["store"] == "folder" and (folder / WEIGHTS_FILE).is_file()
    use_bucket(harness, moto)
    storage = harness.client.get("/api/settings/storage").json()
    assert (storage["models_on_main"], storage["models_on_main_bytes"]) == (1, detail["size_bytes"])
    assert listing(harness).json()["store"] == "folder"
    copied = harness.client.post("/api/settings/storage/copy-models")
    assert copied.status_code == 200 and copied.json() == {"started": ["Tiny"], "skipped": []}
    assert harness.worker(kinds=["repair"]).run_once()
    after = harness.client.get("/api/models/base/tiny").json()
    assert after["store"] == "s3" and {entry["state"] for entry in after["files"]} == {"ok"}
    assert all(in_bucket(moto, harness, sha) for sha in SHA.values())
    assert (folder / WEIGHTS_FILE).read_bytes() == FILES[WEIGHTS_FILE]
    assert listing(harness).json()["store"] == "s3"
    assert harness.client.get("/api/settings/storage").json()["models_on_main"] == 0
    with harness.sessions() as session:
        model = session.get(Model, "tiny")
        assert model is not None and model.store == BUCKET
        assert session.query(AuditEvent).filter(AuditEvent.action == "storage.copy_models").count() == 1


@pytest.mark.parametrize("store_kind", [BUCKET])
@pytest.mark.usefixtures("hub")
def test_an_import_goes_to_the_bucket_and_main_needs_room_for_one_file(
    harness: Harness, tmp_path: Path, moto: FakeS3, monkeypatch: pytest.MonkeyPatch
) -> None:
    folder = tmp_path / "corp"
    folder.mkdir()
    for name, data in FILES.items():
        (folder / name).write_bytes(data)
    body = {"name": "Corp", "source_type": "folder", "location": str(folder)}
    assert harness.client.post("/api/models/import", json=body).status_code == 202
    assert harness.worker(kinds=["import"]).run_once()
    imported = harness.client.get("/api/models/base/corp").json()
    assert imported["availability"]["state"] == "available" and imported["store"] == "s3"
    assert all(in_bucket(moto, harness, hashlib.sha256(data).hexdigest()) for data in FILES.values())
    assert not Path(imported["storage_path"]).exists()
    add_tiny(harness)
    monkeypatch.setattr("minibrain.storage.disk_space", lambda _path: Space(free=0, total=GIB))
    short = harness.client.post("/api/catalog/tiny/download", json={"variant": "tiny:bf16", "accept_license": True})
    assert short.status_code == 409 and "pass the largest file to the bucket" in short.json()["detail"]
