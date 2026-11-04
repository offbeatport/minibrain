import hashlib
import shutil
from datetime import timedelta
from pathlib import Path
from typing import Any

from minibrain.registry.models import Model, ModelStatus, now
from tests.conftest import ADMIN_EMAIL, Harness
from tests.test_flow import bearer
from tests.test_model_health import installed
from tests.test_models import FILES, hub, import_folder

__all__ = ["hub"]

CHAT = {"messages": [{"role": "user", "content": "I was charged twice"}]}


def add_base(harness: Harness, key: str, days: float) -> Path:
    folder = harness.settings.home / "models" / key
    folder.mkdir(parents=True)
    data = key.encode().ljust(3000, b"x")
    (folder / "model.safetensors").write_bytes(data)
    files = [{"path": "model.safetensors", "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}]
    with harness.sessions() as session:
        moment = now() - timedelta(days=days)
        session.add(
            Model(
                id=key,
                source="import",
                name=key.title(),
                status=ModelStatus.AVAILABLE,
                files=files,
                size_bytes=len(data),
                created_at=moment,
                last_used_at=moment,
            )
        )
        session.commit()
    return folder


def evict(harness: Harness, key: str, folder: Path, by: str | None = None) -> None:
    with harness.sessions() as session:
        model = session.get(Model, key)
        assert model is not None
        model.status = ModelStatus.EVICTED
        model.evicted_at = now()
        model.evicted_by = by
        session.commit()
    shutil.rmtree(folder)


def row(harness: Harness, key: str) -> dict[str, Any]:
    return next(item for item in harness.client.get("/api/models").json() if item["key"] == key)


def evicted_at(harness: Harness, key: str) -> object:
    with harness.sessions() as session:
        model = session.get(Model, key)
        assert model is not None
        return model.evicted_at


def test_a_base_removed_by_the_old_cache_downloads_again_against_its_saved_list(harness: Harness, hub: Path) -> None:
    folder = Path(installed(harness)["storage_path"])
    evict(harness, "tiny", folder)
    removed = row(harness, "tiny")
    assert removed["availability"]["state"] == "evicted" and removed["can_test"] is False
    assert (removed["health"]["state"], removed["health"]["label"]) == ("evicted", "Removed to free space")
    assert [action["kind"] for action in removed["health"]["actions"]] == ["download_again", "reimport", "remove"]
    assert "cache" not in removed["health"]["detail"]
    assert harness.client.post("/api/models/base/tiny/test", json={"text": "hi"}).status_code == 409
    assert harness.client.post("/api/models/base/tiny/deploy", json={"deployed": True}).status_code == 409
    entries = harness.client.get("/api/catalog").json()["entries"]
    assert next(entry for entry in entries if entry["id"] == "tiny")["added"][0]["availability"]["state"] == "evicted"
    assert harness.client.post("/api/models/base/tiny/repair").status_code == 202
    restoring = row(harness, "tiny")
    assert restoring["availability"]["state"] == "downloading" and restoring["health"] is None
    assert restoring["activity"]["label"].startswith("Downloading again")
    assert harness.worker(kinds=["repair"]).run_once()
    restored = row(harness, "tiny")
    assert restored["availability"]["state"] == "available" and restored["health"] is None
    assert {path.name: path.read_bytes() for path in folder.iterdir() if path.name in FILES} == FILES
    assert evicted_at(harness, "tiny") is None


def test_a_removed_import_is_reimported_from_a_folder(harness: Harness, tmp_path: Path) -> None:
    source = tmp_path / "corp"
    source.mkdir()
    for name, data in FILES.items():
        (source / name).write_bytes(data)
    stored = Path(import_folder(harness, "Corp", source)["storage_path"])
    evict(harness, "corp", stored)
    removed = row(harness, "corp")
    assert [action["kind"] for action in removed["health"]["actions"]] == ["reimport", "remove"]
    assert str(source) in removed["health"]["detail"]
    assert harness.client.post("/api/models/base/corp/reimport", json={"location": str(source)}).status_code == 202
    assert row(harness, "corp")["availability"]["state"] == "importing"
    assert harness.worker(kinds=["repair"]).run_once()
    assert row(harness, "corp")["availability"]["state"] == "available"
    assert (stored / "model.safetensors").read_bytes() == FILES["model.safetensors"]


def test_files_a_person_removed_name_them_and_block_the_models_built_on_it(harness: Harness) -> None:
    folder = add_base(harness, "old", 10)
    slug = harness.client.post("/api/minibrains", json={"name": "Foo", "base_model": "old"}).json()["slug"]
    harness.client.post(f"/api/minibrains/{slug}/deploy", json={"deployed": True})
    headers = bearer(harness, ("custom", slug))
    evict(harness, "old", folder, by=ADMIN_EMAIL)
    base = row(harness, "old")
    assert base["health"]["label"] == "Files removed" and ADMIN_EMAIL in base["health"]["detail"]
    assert row(harness, slug)["health"]["label"] == "Base missing files"
    served = harness.client.post("/v1/chat/completions", headers=headers, json=CHAT | {"model": slug})
    assert served.status_code == 503 and "files were removed" in served.json()["detail"]


def test_loading_or_testing_a_base_marks_it_used(harness: Harness) -> None:
    add_base(harness, "old", 10)
    add_base(harness, "older", 20)
    body = {"id": "e1", "host": "gpu-1", "url": "http://gpu-1:9000", "base_model": "older", "engine": "mlx"}
    announced = harness.client.post(
        "/internal/gateway/engines", json=body | {"state": "ready"}, headers=harness.gateway_headers
    )
    assert announced.status_code == 204
    assert harness.client.post("/api/models/base/old/test", json={"text": "hi"}).status_code == 200
    with harness.sessions() as session:
        moments = [model.last_used_at for model in session.query(Model)]
    assert all(moment is not None and now() - moment < timedelta(minutes=1) for moment in moments)
    assert row(harness, "old")["last_used_at"] and "pinned" not in row(harness, "old")
