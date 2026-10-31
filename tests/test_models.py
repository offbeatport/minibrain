import hashlib
import json
import os
import threading
from collections.abc import Iterator
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from minibrain.models.catalog import bundled, seed
from minibrain.models.hardware import GIB, Hardware, fit
from minibrain.models.sources import StorageSource, location_url
from minibrain.registry.models import CatalogModel, CatalogVariant
from tests.conftest import Harness
from tests.test_flow import SLUG, add_version, bearer, create_with_dataset, finish

REPO = "test/tiny"
REVISION = "a" * 40
FILES = {
    "config.json": json.dumps({"architectures": ["Qwen3ForCausalLM"]}).encode(),
    "tokenizer.json": b'{"version": "1.0"}',
    "model.safetensors": b"weights" * 1000,
}


def manifest() -> list[dict[str, Any]]:
    return [
        {"path": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        for name, data in sorted(FILES.items())
    ]


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:
        return


@pytest.fixture
def hub(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    root = tmp_path / "hub"
    for name, data in FILES.items():
        target = root / REPO / "resolve" / REVISION / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    latest = {
        "sha": "b" * 40,
        "downloads": 42,
        "siblings": [
            {
                "rfilename": entry["path"],
                "size": entry["size"],
                "lfs": {"sha256": entry["sha256"], "size": entry["size"]},
            }
            for entry in manifest()
        ],
    }
    api = root / "api" / "models" / REPO
    api.parent.mkdir(parents=True, exist_ok=True)
    api.write_text(json.dumps(latest))
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(Quiet, directory=str(root)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setenv("MINIBRAIN_HF_ENDPOINT", f"http://127.0.0.1:{server.server_port}")
    monkeypatch.delenv("MINIBRAIN_OFFLINE", raising=False)
    monkeypatch.delenv("HF_TOKEN", raising=False)
    yield root
    server.shutdown()


def add_tiny(harness: Harness, gated: bool = False) -> None:
    with harness.sessions() as session:
        entry = CatalogModel(
            id="tiny",
            name="Tiny",
            description="A test model",
            provider="Test",
            repo=REPO,
            capabilities=["Chat"],
            license="apache-2.0",
            license_name="Apache 2.0",
            license_summary="Permissive",
            license_url="https://x",
            gated=gated,
            trainable=True,
            template_kwargs={},
            stop_tokens=["<|im_end|>"],
            position=99,
        )
        entry.variants.append(
            CatalogVariant(
                id="tiny:bf16",
                position=0,
                label="BF16",
                format="safetensors",
                precision="bf16",
                repo=REPO,
                revision=REVISION,
                files=manifest(),
                size_bytes=sum(len(d) for d in FILES.values()),
                weights_bytes=len(FILES["model.safetensors"]),
                runtimes=["transformers"],
                requires={},
            )
        )
        session.add(entry)
        session.commit()


def rows(harness: Harness, query: str = "") -> dict[str, dict]:
    return {row["key"]: row for row in harness.client.get(f"/api/models{query}").json()}


def download_tiny(harness: Harness) -> dict:
    body = {"variant": "tiny:bf16", "accept_license": True}
    response = harness.client.post("/api/catalog/tiny/download", json=body)
    assert response.status_code == 202, response.text
    return response.json()


def test_bundled_catalogue_is_seeded_once_and_real(harness: Harness) -> None:
    entries = harness.client.get("/api/catalog").json()["entries"]
    ids = [entry["id"] for entry in entries]
    assert ids[:2] == ["qwen3-0.6b", "qwen3-1.7b"]
    qwen = entries[0]["variants"][0]
    assert qwen["revision"] == "c1899de289a04d12100db370d81485cdf75e47ca"
    assert qwen["files"] >= 5 and qwen["size_bytes"] > 1_000_000_000
    llama = next(entry for entry in entries if entry["id"] == "llama-3.1-8b-instruct")
    assert llama["gated"] is True and llama["variants"][0]["size_bytes"] < 20_000_000_000
    with harness.sessions() as session:
        assert seed(session) is False
    assert bundled()["snapshot"]


def test_fit_levels_have_a_basis() -> None:
    mac = Hardware("mac", "Apple GPU", "mps", 11 * GIB, 16 * GIB, "GPU-usable unified memory")
    assert fit(1 * GIB, {}, mac)["level"] == "fits"
    assert fit(8 * GIB, {}, mac)["level"] == "limited"
    assert fit(16 * GIB, {}, mac)["level"] == "insufficient"
    fp8 = fit(9 * GIB, {"accelerator": "cuda", "note": "FP8 needs an NVIDIA GPU."}, mac)
    assert (fp8["level"], fp8["basis"]) == ("insufficient", "FP8 needs an NVIDIA GPU.")
    unknown = fit(1 * GIB, {}, None)
    assert unknown["level"] == "unknown" and unknown["basis"].startswith("Needs about")


def test_download_appears_in_my_models_and_validates(harness: Harness, hub: Path) -> None:
    add_tiny(harness)
    assert harness.client.post("/api/catalog/tiny/download", json={"variant": "tiny:bf16"}).status_code == 409
    row = download_tiny(harness)
    assert (row["kind"], row["availability"]["state"], row["deployment"]["state"]) == (
        "base",
        "downloading",
        "not_deployed",
    )
    added = next(e for e in harness.client.get("/api/catalog").json()["entries"] if e["id"] == "tiny")["added"]
    assert added[0]["availability"]["state"] == "downloading"
    assert harness.worker(kinds=["download"]).run_once()
    detail = harness.client.get("/api/models/base/tiny").json()
    assert detail["availability"]["state"] == "available"
    assert detail["license_ack_by"] == "Local user"
    stored = Path(detail["storage_path"])
    assert all(hashlib.sha256((stored / name).read_bytes()).hexdigest() for name in FILES)
    (stored / "model.safetensors").unlink()
    assert rows(harness)["tiny"]["availability"]["state"] == "missing"


def test_checksum_mismatch_is_retried_not_trusted(harness: Harness, hub: Path) -> None:
    add_tiny(harness)
    (hub / REPO / "resolve" / REVISION / "model.safetensors").write_bytes(b"tampered" * 875)
    download_tiny(harness)
    harness.worker(kinds=["download"]).run_once()
    job = harness.client.get("/api/jobs?kind=download").json()[0]
    assert job["status"] == "queued" and "failed validation" in (job["error"] or "")
    assert rows(harness)["tiny"]["availability"]["state"] == "downloading"


def test_gated_download_fails_with_the_fix_and_retries(harness: Harness, hub: Path, monkeypatch) -> None:
    add_tiny(harness, gated=True)
    response = harness.client.post("/api/catalog/tiny/download", json={"variant": "tiny:bf16", "accept_license": True})
    assert response.status_code == 409 and "set HF_TOKEN" in response.json()["detail"]
    monkeypatch.setenv("HF_TOKEN", "hf_test")
    download_tiny(harness)
    monkeypatch.delenv("HF_TOKEN")
    harness.worker(kinds=["download"]).run_once()
    failed = harness.client.get("/api/models/base/tiny").json()
    assert failed["availability"]["state"] == "not_downloaded"
    assert failed["activity"]["label"] == "Download failed" and "HF_TOKEN" in failed["error"]
    monkeypatch.setenv("HF_TOKEN", "hf_test")
    assert harness.client.post("/api/models/base/tiny/retry").json()["availability"]["state"] == "downloading"
    assert harness.worker(kinds=["download"]).run_once()
    assert rows(harness)["tiny"]["availability"]["state"] == "available"


def test_import_from_a_folder(harness: Harness, tmp_path: Path) -> None:
    folder = tmp_path / "corp-model"
    folder.mkdir()
    for name, data in FILES.items():
        (folder / name).write_bytes(data)
    body = {"name": "Corp LLM", "source_type": "folder", "location": str(folder), "tags": ["legal"]}
    row = harness.client.post("/api/models/import", json=body).json()
    assert (row["key"], row["availability"]["state"]) == ("corp-llm", "importing")
    assert harness.worker(kinds=["import"]).run_once()
    detail = harness.client.get("/api/models/base/corp-llm").json()
    assert detail["availability"]["state"] == "available"
    assert {f["path"]: f["sha256"] for f in detail["files"]}["model.safetensors"] == manifest()[1]["sha256"]
    bad = harness.client.post("/api/models/import", json=body | {"name": "Empty", "location": str(tmp_path)}).json()
    harness.worker(kinds=["import"]).run_once()
    assert "config.json" in harness.client.get(f"/api/models/base/{bad['key']}").json()["error"]


def test_storage_sources_read_buckets_and_folders(tmp_path: Path) -> None:
    import fsspec

    memory = fsspec.filesystem("memory")
    for name, data in FILES.items():
        memory.pipe(f"/bucket/model/{name}", data)
    source = StorageSource("memory://bucket/model")
    assert [entry["path"] for entry in source.files()] == sorted(FILES)
    assert b"".join(source.chunks("tokenizer.json")) == FILES["tokenizer.json"]
    assert location_url("s3", "s3://bucket/x/") == "s3://bucket/x"
    assert location_url("folder", "~/models") == str(Path("~/models").expanduser())


def publish_catalogue(hub: Path, monkeypatch: pytest.MonkeyPatch, revision: str) -> None:
    variant = {
        "id": "tiny:bf16",
        "label": "BF16",
        "format": "safetensors",
        "precision": "bf16",
        "repo": REPO,
        "revision": revision,
        "files": manifest(),
        "size_bytes": 1,
        "weights_bytes": 1,
        "runtimes": ["transformers"],
        "requires": {},
    }
    snapshot = {
        "snapshot": "9999-01-01.1",
        "entries": [{"id": "tiny", "repo": REPO, "popularity": 7, "variants": [variant]}],
    }
    (hub / "catalog.json").write_text(json.dumps(snapshot))
    monkeypatch.setenv("MINIBRAIN_CATALOG_URL", f"{os.environ['MINIBRAIN_HF_ENDPOINT']}/catalog.json")


def test_catalogue_sync_reads_our_url_and_keeps_pins(
    harness: Harness, hub: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    add_tiny(harness)
    download_tiny(harness)
    harness.worker(kinds=["download"]).run_once()
    monkeypatch.delenv("MINIBRAIN_CATALOG_URL", raising=False)
    assert harness.client.post("/api/catalog/sync").status_code == 409
    publish_catalogue(hub, monkeypatch, "b" * 40)
    assert harness.client.post("/api/catalog/sync").status_code == 202
    assert harness.worker(kinds=["catalog_sync"]).run_once()
    row = rows(harness)["tiny"]
    assert row["update_available"] is True
    assert harness.client.get("/api/models/base/tiny").json()["revision"] == REVISION
    with harness.sessions() as session:
        entry = session.get(CatalogModel, "tiny")
        assert entry is not None and entry.popularity == 7
    assert harness.client.get("/api/catalog/settings").json() == {"daily_sync": False}


def test_my_models_shows_training_and_serving_independently(harness: Harness) -> None:
    create_with_dataset(harness)
    add_version(harness, "prompt")
    finish(harness, "eval", accuracy=0.4)
    add_version(harness, "lora")
    claim = harness.claim(["train"])
    assert claim is not None
    progress = [{"kind": "progress", "message": "", "data": {"progress": 0.65}}]
    harness.internal(f"/jobs/{claim['job_id']}/events", {"token": claim["token"], "events": progress})
    row = rows(harness)[SLUG]
    assert (row["activity"]["label"], row["activity"]["progress"]) == ("v1 training", 0.65)
    assert (row["deployment"]["label"], row["deployment"]["state"]) == ("v0 · Running", "running")
    assert row["availability"]["state"] == "none"
    harness.internal(f"/jobs/{claim['job_id']}/fail", {"token": claim["token"], "error": "oom", "retryable": False})
    assert rows(harness)[SLUG]["activity"] == {
        "state": "failed",
        "label": "Training failed",
        "kind": "train",
        "version": 1,
        "progress": None,
        "job_id": claim["job_id"],
    }
    harness.client.post("/api/minibrains", json={"name": "Draft"})
    assert rows(harness)["draft"]["activity"]["label"] == "Needs examples"
    harness.client.patch("/api/minibrains/draft", json={"archived": True, "tags": ["x"]})
    assert "draft" not in rows(harness)
    assert rows(harness, "?archived=true")["draft"]["archived"] is True


def test_ready_candidate_is_reported(harness: Harness) -> None:
    create_with_dataset(harness)
    add_version(harness, "prompt")
    finish(harness, "eval", accuracy=0.4)
    add_version(harness, "lora")
    finish(harness, "train")
    finish(harness, "eval", accuracy=0.9)
    row = rows(harness)[SLUG]
    assert (row["activity"]["label"], row["ready_version"], row["availability"]["state"]) == (
        "v1 ready",
        1,
        "available",
    )


def test_base_models_deploy_through_the_gateway(harness: Harness, tmp_path: Path) -> None:
    folder = tmp_path / "base"
    folder.mkdir()
    for name, data in FILES.items():
        (folder / name).write_bytes(data)
    harness.client.post(
        "/api/models/import", json={"name": "Base One", "source_type": "folder", "location": str(folder)}
    )
    harness.worker(kinds=["import"]).run_once()
    assert harness.client.post("/api/models/base/base-one/deploy", json={"deployed": True}).status_code == 200
    secret = harness.client.post("/api/models/base/base-one/keys", json={"name": "ci"}).json()["secret"]
    headers = {"Authorization": f"Bearer {secret}"}
    models = harness.client.get("/v1/models", headers=headers).json()
    assert [model["id"] for model in models["data"]] == ["base-one"]
    chat = {
        "model": "base-one",
        "messages": [{"role": "system", "content": "Be brief"}, {"role": "user", "content": "Hi"}],
    }
    reply = harness.client.post("/v1/chat/completions", headers=headers, json=chat)
    assert reply.status_code == 200
    sent = harness.backend.requests[-1]
    assert sent.messages == chat["messages"] and sent.base.key == "base-one" and sent.base.path
    create_with_dataset(harness)
    other = bearer(harness)
    assert harness.client.post("/v1/chat/completions", headers=other, json=chat).status_code == 404
    tested = harness.client.post("/api/models/base/base-one/test", json={"text": "Hello"}).json()
    assert tested["output"] == "billing"
    assert rows(harness)["base-one"]["deployment"]["label"] == "Running"


def hf_folder(root: Path, revision: str | None = REVISION) -> Path:
    root.mkdir(parents=True)
    for name, data in FILES.items():
        (root / name).write_bytes(data)
    if revision is not None:
        meta = root / ".cache" / "huggingface" / "download"
        meta.mkdir(parents=True)
        (meta / "config.json.metadata").write_text(f"{revision}\netag\n1700000000\n")
    return root


def import_folder(harness: Harness, name: str, folder: Path, **extra: str) -> dict:
    body = {"name": name, "source_type": "folder", "location": str(folder), **extra}
    row = harness.client.post("/api/models/import", json=body).json()
    harness.worker(kinds=["import"]).run_once()
    return harness.client.get(f"/api/models/base/{row['key']}").json()


def test_hf_download_folder_is_verified_against_the_catalogue(harness: Harness, tmp_path: Path) -> None:
    add_tiny(harness)
    verified = import_folder(harness, "Tiny Copy", hf_folder(tmp_path / "hf"))
    assert (verified["verified"], verified["catalog_id"], verified["revision"]) == (True, "tiny", REVISION)
    assert verified["trainable"] is True and verified["availability"]["state"] == "available"
    plain = import_folder(harness, "Plain", hf_folder(tmp_path / "plain", revision=None))
    assert (plain["verified"], plain["catalog_id"]) == (False, None)
    picked = import_folder(harness, "Picked", hf_folder(tmp_path / "picked", revision=None), variant_id="tiny:bf16")
    assert picked["verified"] is True
    tampered = hf_folder(tmp_path / "tampered")
    (tampered / "model.safetensors").write_bytes(b"other" * 1400)
    failed = import_folder(harness, "Tampered", tampered)
    assert "does not match the catalogue checksum" in failed["error"]


def test_import_rejects_pickle_and_incomplete_shards(harness: Harness, tmp_path: Path) -> None:
    pickle = tmp_path / "pickle"
    pickle.mkdir()
    (pickle / "config.json").write_text(json.dumps({"architectures": ["LlamaForCausalLM"]}))
    (pickle / "tokenizer.json").write_text("{}")
    (pickle / "pytorch_model.bin").write_bytes(b"not loaded")
    assert "pickle weights can run code" in import_folder(harness, "Pickle", pickle)["error"]
    sharded = hf_folder(tmp_path / "sharded", revision=None)
    index = {"weight_map": {"a": "model-00001-of-00002.safetensors", "b": "model-00002-of-00002.safetensors"}}
    (sharded / "model.safetensors.index.json").write_text(json.dumps(index))
    (sharded / "model-00001-of-00002.safetensors").write_bytes(b"shard")
    assert "missing model-00002-of-00002" in import_folder(harness, "Sharded", sharded)["error"]


def test_add_from_hugging_face_by_link_or_id(harness: Harness, hub: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from minibrain.models.hubadd import HubAddError, parse_repo

    assert parse_repo("https://huggingface.co/Qwen/Qwen3-8B/tree/main") == "Qwen/Qwen3-8B"
    assert parse_repo(" Qwen/Qwen3-8B ") == "Qwen/Qwen3-8B"
    with pytest.raises(HubAddError):
        parse_repo("not a repo")
    api = hub / "api" / "models" / REPO
    api.write_text(json.dumps(json.loads(api.read_text()) | {"config": {"model_type": "qwen3"}}))
    response = harness.client.post("/api/catalog/hub", json={"repo": f"{os.environ['MINIBRAIN_HF_ENDPOINT']}/{REPO}"})
    assert response.status_code == 201
    entry = response.json()
    assert (entry["origin"], entry["support"], entry["architecture"]) == ("hub", "supported", "qwen3")
    assert entry["variants"][0]["revision"] == "b" * 40
    again = harness.client.post("/api/catalog/hub", json={"repo": REPO}).json()
    assert again["id"] == entry["id"]
    assert harness.client.delete(f"/api/catalog/{entry['id']}").status_code == 204
    assert harness.client.delete("/api/catalog/qwen3-0.6b").status_code == 409
    monkeypatch.setenv("MINIBRAIN_OFFLINE", "1")
    assert harness.client.post("/api/catalog/hub", json={"repo": REPO}).status_code == 403


def test_unknown_architecture_is_marked_untested(harness: Harness, hub: Path) -> None:
    entry = harness.client.post("/api/catalog/hub", json={"repo": REPO}).json()
    assert entry["support"] == "untested"
    assert harness.client.post("/api/catalog/hub", json={"repo": "test/missing"}).status_code == 409
