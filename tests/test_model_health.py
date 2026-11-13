import hashlib
import json
import shutil
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from minibrain.api.model_health import HealthContext, capability
from minibrain.base_models import BaseModelSpec
from minibrain.models.files import Progress
from minibrain.models.health import content_hash
from minibrain.models.transfer import fetch
from minibrain.registry.models import AuditEvent, BaseModel, CatalogModel, CatalogVariant
from minibrain.serve.engine import create_engine_app, load_failure
from minibrain.serve.select import NoEngineError
from minibrain.settings import Settings
from tests.conftest import FakeBackend, Harness, blank_dataset, give_data, tickets_csv
from tests.test_flow import SLUG, add_version, bearer, build_dataset, deploy, finish
from tests.test_models import FILES, REPO, REVISION, Quiet, add_tiny, download_tiny, hub, manifest

WEIGHTS = "model.safetensors"


def installed(harness: Harness) -> dict[str, Any]:
    add_tiny(harness)
    download_tiny(harness)
    assert harness.worker(kinds=["download"]).run_once()
    return harness.client.get("/api/models/tiny").json()


def row(harness: Harness, key: str = "tiny") -> dict[str, Any]:
    return next(item for item in harness.client.get("/api/models").json() if item["key"] == key)


def actions(found: dict[str, Any]) -> list[str]:
    return [action["kind"] for action in found["health"]["actions"]]


def audited(harness: Harness, action: str) -> list[AuditEvent]:
    with harness.sessions() as session:
        return session.query(AuditEvent).filter(AuditEvent.action == action).all()


def refuse(monkeypatch: pytest.MonkeyPatch, suffix: str, status: int) -> Callable[[], None]:
    original = Quiet.do_GET

    def do_get(handler: Quiet) -> None:
        if handler.path.endswith(suffix):
            handler.send_error(status)
            return
        original(handler)

    monkeypatch.setattr(Quiet, "do_GET", do_get)
    return lambda: monkeypatch.setattr(Quiet, "do_GET", original)


def chat(harness: Harness, model: str, headers: dict[str, str]) -> Any:
    body = {"model": model, "messages": [{"role": "user", "content": "hi"}]}
    return harness.client.post("/v1/chat/completions", headers=headers, json=body)


def test_install_saves_a_sha256_list_of_every_file(harness: Harness, hub: Path, tmp_path: Path) -> None:
    detail = installed(harness)
    stored = Path(detail["storage_path"])
    saved = json.loads((stored / "minibrain-model.json").read_text())
    assert {entry["path"]: entry["sha256"] for entry in saved["files"]} == {
        entry["path"]: entry["sha256"] for entry in manifest()
    }
    assert saved["content_hash"] == detail["content_hash"] == content_hash(manifest())
    assert {entry["state"] for entry in detail["files"]} == {"ok"} and detail["verified_at"]
    folder = tmp_path / "corp"
    folder.mkdir()
    for name, data in FILES.items():
        (folder / name).write_bytes(data)
    harness.client.post("/api/models/import", json={"name": "Corp", "source_type": "folder", "location": str(folder)})
    assert harness.worker(kinds=["import"]).run_once()
    imported = harness.client.get("/api/models/corp").json()
    local = json.loads((Path(imported["storage_path"]) / "minibrain-model.json").read_text())
    assert all(entry["sha256"] for entry in local["files"]) and local["content_hash"] == imported["content_hash"]


def test_corrupt_file_is_found_by_verify_and_repaired_from_the_hub(harness: Harness, hub: Path) -> None:
    stored = Path(installed(harness)["storage_path"])
    assert harness.client.post("/api/models/tiny/deploy", json={"deployed": True}).status_code == 200
    headers = bearer(harness, ("base", "tiny"))
    (stored / WEIGHTS).write_bytes(b"tampers" * 1000)
    assert row(harness)["health"] is None
    verifying = harness.client.post("/api/models/tiny/verify")
    assert verifying.status_code == 202 and verifying.json()["activity"]["label"].startswith("Verifying files")
    assert harness.client.post("/api/models/tiny/repair").status_code == 409
    assert harness.worker(kinds=["verify"]).run_once()
    found = row(harness)
    assert (found["health"]["state"], found["health"]["label"]) == ("corrupt", "Corrupt (1 file)")
    assert actions(found) == ["repair", "reimport", "verify"] and found["health"]["files"] == [WEIGHTS]
    assert "SHA-256" in found["health"]["detail"] and found["can_test"] is False
    files = {entry["path"]: entry["state"] for entry in harness.client.get("/api/models/tiny").json()["files"]}
    assert files[WEIGHTS] == "corrupt" and files["config.json"] == "ok"
    refused = chat(harness, "tiny", headers)
    assert refused.status_code == 503 and "cannot be loaded" in refused.json()["detail"]
    assert harness.client.post("/api/models/tiny/test", json={"text": "hi"}).status_code == 409
    assert harness.client.post("/api/models/tiny/repair").status_code == 202
    assert row(harness)["activity"]["label"].startswith("Repairing")
    assert harness.worker(kinds=["repair"]).run_once()
    assert (stored / WEIGHTS).read_bytes() == FILES[WEIGHTS]
    assert row(harness)["health"] is None and chat(harness, "tiny", headers).status_code == 200
    assert [event.detail["source"] for event in audited(harness, "model.repair")] == [f"{REPO}@{REVISION}"]
    assert len(audited(harness, "model.verify")) == 1


def test_missing_files_point_to_a_new_location_validated_against_the_saved_list(
    harness: Harness, hub: Path, tmp_path: Path
) -> None:
    stored = Path(installed(harness)["storage_path"])
    moved = tmp_path / "moved"
    shutil.move(stored, moved)
    found = row(harness)
    assert (found["health"]["state"], found["availability"]["state"]) == ("missing", "missing")
    assert actions(found) == ["repair", "relocate", "remove"] and WEIGHTS in found["health"]["detail"]
    empty = tmp_path / "empty"
    empty.mkdir()
    refused = harness.client.post("/api/models/tiny/relocate", json={"location": str(empty)})
    assert refused.status_code == 409 and "config.json is missing" in refused.json()["detail"]
    short = tmp_path / "short"
    shutil.copytree(moved, short)
    (short / WEIGHTS).write_bytes(b"weights")
    wrong = harness.client.post("/api/models/tiny/relocate", json={"location": str(short)}).json()["detail"]
    assert f"{WEIGHTS} is 7 bytes, expected {len(FILES[WEIGHTS])}" in wrong
    pointed = harness.client.post("/api/models/tiny/relocate", json={"location": str(moved)})
    assert pointed.status_code == 200 and pointed.json()["storage_path"] == str(moved)
    assert pointed.json()["relocated"] is True and pointed.json()["activity"]["label"].startswith("Verifying files")
    assert harness.worker(kinds=["verify"]).run_once()
    assert row(harness)["health"] is None and row(harness)["availability"]["state"] == "available"
    assert [event.detail["to"] for event in audited(harness, "model.relocate")] == [str(moved)]
    assert harness.client.delete("/api/models/tiny").status_code == 202
    harness.settle()
    assert all(item["key"] != "tiny" for item in harness.client.get("/api/models").json())
    assert (moved / WEIGHTS).is_file()


def test_download_checks_free_space_before_writing(harness: Harness, hub: Path) -> None:
    add_tiny(harness)
    download_tiny(harness)
    assert harness.worker(kinds=["download"], modules={"download": "tests.full_disk"}).run_once()
    found = row(harness)
    assert (found["health"]["state"], found["health"]["label"]) == ("no_space", "Not enough space")
    assert actions(found) == ["storage", "resume"] and "free on the disk that holds models" in found["health"]["detail"]
    stored = Path(harness.client.get("/api/models/tiny").json()["storage_path"])
    assert not any(stored.glob("*.part")) and not (stored / WEIGHTS).exists()
    assert harness.client.post("/api/models/tiny/retry").status_code == 202
    assert harness.worker(kinds=["download"]).run_once()
    assert row(harness)["health"] is None


def test_hub_401_needs_access_and_404_cannot_repair_from_source(
    harness: Harness, hub: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    add_tiny(harness)
    allow = refuse(monkeypatch, WEIGHTS, 401)
    download_tiny(harness)
    assert harness.worker(kinds=["download"]).run_once()
    found = row(harness)
    assert (found["health"]["state"], found["health"]["label"]) == ("needs_access", "Needs access")
    assert actions(found) == ["get_access", "resume"]
    assert "(401)" in found["health"]["detail"] and "HF_TOKEN" in found["health"]["detail"]
    allow()
    assert harness.client.post("/api/models/tiny/retry").status_code == 202
    assert harness.worker(kinds=["download"]).run_once()
    stored = Path(harness.client.get("/api/models/tiny").json()["storage_path"])
    (stored / WEIGHTS).unlink()
    (hub / REPO / "resolve" / REVISION / WEIGHTS).unlink()
    assert harness.client.post("/api/models/tiny/repair").status_code == 202
    assert harness.worker(kinds=["repair"]).run_once()
    gone = row(harness)
    assert (gone["health"]["state"], gone["health"]["label"]) == ("source_gone", "Can't repair from source")
    assert actions(gone) == ["reimport", "verify"] and "no longer published" in gone["health"]["detail"]


def test_reimport_restores_files_only_from_an_identical_copy(harness: Harness, hub: Path, tmp_path: Path) -> None:
    stored = Path(installed(harness)["storage_path"])
    (stored / WEIGHTS).unlink()
    other = tmp_path / "other"
    other.mkdir()
    for name, data in FILES.items():
        (other / name).write_bytes(b"different" * 778 if name == WEIGHTS else data)
    (other / WEIGHTS).write_bytes((other / WEIGHTS).read_bytes()[: len(FILES[WEIGHTS])])
    assert harness.client.post("/api/models/tiny/reimport", json={"location": str(other)}).status_code == 202
    assert harness.worker(kinds=["repair"]).run_once()
    failed = row(harness)
    assert failed["health"]["label"] == "Re-import failed" and "different files" in failed["health"]["detail"]
    backup = tmp_path / "backup"
    backup.mkdir()
    for name, data in FILES.items():
        (backup / name).write_bytes(data)
    assert harness.client.post("/api/models/tiny/reimport", json={"location": str(backup)}).status_code == 202
    assert harness.worker(kinds=["repair"]).run_once()
    assert row(harness)["health"] is None and (stored / WEIGHTS).read_bytes() == FILES[WEIGHTS]
    assert [event.detail["source"] for event in audited(harness, "model.reimport")] == [str(other), str(backup)]


def train_on(harness: Harness, base: str) -> None:
    created = harness.client.post(
        "/api/models",
        json={
            "dataset": blank_dataset(harness.client),
            "preset": "classify",
            "labels": ["billing", "bug"],
            "name": "Support Triage",
            "base_model": base,
        },
    )
    assert created.status_code == 201
    give_data(harness, SLUG)
    build_dataset(harness)
    add_version(harness, "lora")
    finish(harness, "train")
    finish(harness, "eval", accuracy=0.9)


def test_adapter_refuses_a_base_whose_files_changed(harness: Harness, hub: Path, tmp_path: Path) -> None:
    detail = installed(harness)
    train_on(harness, "tiny")
    deploy(harness, 1)
    headers = bearer(harness)
    assert chat(harness, SLUG, headers).status_code == 200
    with harness.sessions() as session:
        model = session.get(BaseModel, "tiny")
        assert model is not None
        model.files = [entry | {"sha256": "0" * 64} if entry["path"] == WEIGHTS else entry for entry in model.files]
        session.commit()
    refused = chat(harness, SLUG, headers)
    assert refused.status_code == 409
    assert f"trained on tiny with files {detail['content_hash'][:12]}" in refused.json()["detail"]
    version = row(harness, SLUG)["versions"][0]
    assert (version["health"]["state"], version["health"]["label"]) == ("base_changed", "Base changed")
    assert harness.client.post(f"/api/models/{SLUG}/versions/1/promote").status_code == 409
    spec = BaseModelSpec(key="tiny", repo=REPO, revision=REVISION, license="apache-2.0", content_hash="b" * 64)
    engine = create_engine_app(spec, "http://main", "t", tmp_path / "engine", backend=FakeBackend())
    with TestClient(engine) as client:
        adapter = {"name": f"{SLUG}-v0", "artifact": {}, "base_hash": "a" * 64}
        body = {"messages": [{"role": "user", "content": "hi"}], "adapter": adapter}
        assert client.post("/generate", json=body).status_code == 409


def test_engine_load_failures_become_a_state_with_a_way_out(harness: Harness, hub: Path) -> None:
    installed(harness)
    spec = BaseModelSpec("tiny", REPO, REVISION, "apache-2.0")
    oom = load_failure(MemoryError("CUDA out of memory"), spec, "gpu-01")
    assert oom["code"] == "no_memory" and "gpu-01" in oom["error"]
    assert load_failure(NoEngineError("GGUF weights need llama.cpp"), spec, "h")["code"] == "cant_run"
    missing = ModuleNotFoundError("No module named 'llama_cpp'", name="llama_cpp")
    assert "minibrain[llamacpp]" in load_failure(missing, spec, "h")["error"]
    body = {
        "id": "e-1",
        "host": "gpu-01",
        "url": "http://gpu-01:9000",
        "base_model": "tiny",
        "engine": "transformers",
        "state": "failed",
    }
    response = harness.client.post("/internal/gateway/engines", json=body | oom, headers=harness.gateway_headers)
    assert response.status_code == 204
    found = row(harness)
    assert (found["health"]["state"], found["health"]["label"]) == ("no_memory", "Failed to start")
    assert actions(found) == ["find_smaller", "try_again"] and "smaller" in found["health"]["detail"]
    assert harness.client.post("/api/models/tiny/deploy", json={"deployed": True}).status_code == 409
    assert harness.client.post("/api/models/tiny/recheck").status_code == 200
    assert row(harness)["health"] is None


class Halves:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.offsets: list[int] = []

    def describe(self) -> str:
        return "halves"

    @contextmanager
    def opened(self, path: str, offset: int) -> Iterator[tuple[int, Iterator[bytes]]]:
        self.offsets.append(offset)
        yield offset, iter([self.data[offset:]])


def test_interrupted_download_resumes_from_the_partial_file(tmp_path: Path) -> None:
    data = FILES[WEIGHTS]
    (tmp_path / f"{WEIGHTS}.part").write_bytes(data[:3000])
    source = Halves(data)
    entry = {"path": WEIGHTS, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    digest = fetch(source, entry, tmp_path, Progress(len(data), "downloading"))
    assert source.offsets == [3000] and digest == entry["sha256"]
    assert (tmp_path / f"{WEIGHTS}.part").read_bytes() == data


def test_gguf_without_llama_cpp_offers_to_add_the_safetensors_variant(settings: Settings) -> None:
    gguf = CatalogVariant(id="tiny-q8", label="GGUF Q8_0", format="gguf", precision="q8_0", repo=REPO, revision="r")
    plain = CatalogVariant(
        id="tiny-bf16", label="BF16 safetensors", format="safetensors", precision="bf16", repo=REPO, revision="r"
    )
    CatalogModel(id="tiny", variants=[gguf, plain])
    model = BaseModel(id="tiny-q8", name="Tiny", files=[{"path": "tiny.gguf", "size": 1}], variant=gguf)
    found = capability(model, HealthContext(settings=settings, hub_ok=True, engines=frozenset({"transformers"})))
    assert found is not None and found.state == "cant_run" and "add BF16 safetensors instead" in found.detail
    assert [(item.kind, item.label) for item in found.actions] == [("pick_variant", "View details")]
    ready = HealthContext(settings=settings, hub_ok=True, engines=frozenset({"llamacpp"}))
    assert capability(model, ready) is None
