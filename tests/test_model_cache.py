import hashlib
import logging
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest

from minibrain.models.health import content_hash
from minibrain.registry.models import (
    AuditEvent,
    EngineReplica,
    Job,
    Minibrain,
    Model,
    ModelStatus,
    Snapshot,
    Version,
    now,
)
from minibrain.storage import GIB
from tests.conftest import Harness
from tests.test_model_health import installed
from tests.test_models import FILES, hub, import_folder

__all__ = ["hub"]

SIZE = 3000


def add_base(
    harness: Harness, key: str, days: float, pinned: bool = False, deployed: bool = False, path: str | None = None
) -> Path:
    folder = harness.settings.home / "models" / key
    folder.mkdir(parents=True)
    data = key.encode().ljust(SIZE, b"x")
    (folder / "model.safetensors").write_bytes(data)
    files = [{"path": "model.safetensors", "size": SIZE, "sha256": hashlib.sha256(data).hexdigest()}]
    with harness.sessions() as session:
        moment = now() - timedelta(days=days)
        session.add(
            Model(
                id=key,
                source="import",
                name=key.title(),
                status=ModelStatus.AVAILABLE,
                files=files,
                size_bytes=SIZE,
                created_at=moment,
                last_used_at=moment,
                pinned=pinned,
                deployed=deployed,
                path=path,
            )
        )
        session.commit()
    return folder


def budget(harness: Harness, size: int, enabled: bool = True) -> None:
    body = {"enabled": enabled, "budget_gb": size / GIB}
    assert harness.client.put("/api/settings/model-cache", json=body).status_code == 200


def free(harness: Harness) -> dict[str, Any]:
    response = harness.client.post("/api/models/cache/free")
    assert response.status_code == 200, response.text
    return response.json()


def estimate(harness: Harness, size: int) -> dict[str, Any]:
    return harness.client.post("/api/models/cache/estimate", json={"size_bytes": size}).json()


def status(harness: Harness, key: str) -> str:
    with harness.sessions() as session:
        model = session.get(Model, key)
        assert model is not None
        return model.status


def age(harness: Harness, key: str, days: float) -> None:
    with harness.sessions() as session:
        model = session.get(Model, key)
        assert model is not None
        model.last_used_at = now() - timedelta(days=days)
        session.commit()


def evictions(harness: Harness) -> list[AuditEvent]:
    with harness.sessions() as session:
        return session.query(AuditEvent).filter(AuditEvent.action == "model.evict").order_by(AuditEvent.id).all()


def cache(harness: Harness) -> dict[str, Any]:
    return harness.client.get("/api/models/cache").json()


def kept(harness: Harness) -> dict[str, list[str]]:
    return {base["key"]: base["kept"] for base in cache(harness)["bases"]}


def row(harness: Harness, key: str) -> dict[str, Any]:
    return next(item for item in harness.client.get("/api/models").json() if item["key"] == key)


def keys(found: dict[str, Any]) -> list[str]:
    return [base["key"] for base in found["evict"]]


def test_the_budget_is_off_by_default_and_then_removes_nothing(harness: Harness) -> None:
    folders = [add_base(harness, key, days) for key, days in (("old", 30), ("older", 60))]
    assert harness.client.get("/api/settings/model-cache").json() == {"enabled": False, "budget_gb": 100.0}
    found = free(harness)
    assert (found["enabled"], found["evict"], found["over"]) == (False, [], False)
    info = cache(harness)
    assert (info["enabled"], info["used_bytes"], info["evictable_bytes"]) == (False, 2 * SIZE, 2 * SIZE)
    assert all(folder.is_dir() for folder in folders) and not evictions(harness)
    budget(harness, SIZE, enabled=False)
    assert free(harness)["evict"] == [] and status(harness, "older") == ModelStatus.AVAILABLE


def test_least_recently_used_unused_bases_are_removed_until_under_budget(
    harness: Harness, caplog: pytest.LogCaptureFixture
) -> None:
    folders = {key: add_base(harness, key, days) for key, days in (("recent", 2), ("oldest", 10), ("middle", 5))}
    assert [base["key"] for base in cache(harness)["bases"]] == ["oldest", "middle", "recent"]
    budget(harness, SIZE + 500)
    with caplog.at_level(logging.INFO, logger="minibrain.models"):
        found = free(harness)
    assert keys(found) == ["oldest", "middle"]
    assert (found["freed_bytes"], found["after_bytes"], found["still_over"]) == (2 * SIZE, SIZE, False)
    assert [status(harness, key) for key in ("oldest", "middle", "recent")] == ["evicted", "evicted", "available"]
    assert not folders["oldest"].exists() and not folders["middle"].exists() and folders["recent"].is_dir()
    events = evictions(harness)
    assert [event.target for event in events] == ["oldest", "middle"]
    assert {event.actor for event in events} == {"admin@example.com"}
    assert events[0].detail["trigger"] == "manual" and events[0].detail["size_bytes"] == SIZE
    assert events[0].detail["used_bytes"] == 3 * SIZE and events[0].detail["last_used_at"]
    assert "removed oldest" in caplog.text and "removed middle" in caplog.text
    assert free(harness)["evict"] == [] and len(evictions(harness)) == 2


def test_used_pinned_and_recent_bases_are_never_removed(harness: Harness) -> None:
    for key in ("custom", "trained", "deployed", "pinned", "busy", "loaded", "recent", "spare"):
        add_base(harness, key, 0.01 if key == "recent" else 20, pinned=key == "pinned", deployed=key == "deployed")
    with harness.sessions() as session:
        trained = session.get(Model, "trained")
        assert trained is not None
        session.add(Minibrain(slug="triage", name="Triage", task="classify", base_model="custom"))
        moved = Minibrain(slug="moved", name="Moved", task="classify", base_model="elsewhere")
        snapshot = Snapshot(hash="s" * 64, counts={}, labels=[])
        session.add_all([moved, snapshot])
        session.flush()
        version = Version(
            minibrain_id=moved.id,
            snapshot_id=snapshot.id,
            number=1,
            kind="lora",
            status="ready",
            base_hash=content_hash(trained.files),
        )
        replica = EngineReplica(
            id="e1", node_id="local/a", pool="local", base_model="loaded", engine="mlx", url="http://e", state="ready"
        )
        session.add_all([version, replica, Job(kind="verify", model_id="busy", status="running")])
        session.commit()
    budget(harness, 1)
    reasons = kept(harness)
    assert reasons["custom"] == ["Base of Triage"]
    assert reasons["trained"] == ["Versions of Moved were trained on it"]
    assert reasons["deployed"] == ["Deployed"] and reasons["pinned"] == ["Pinned"]
    assert reasons["busy"] == ["A verify job is running"] and reasons["loaded"] == ["Loaded by an engine"]
    assert reasons["recent"] == ["Used in the last hour"] and reasons["spare"] == []
    found = free(harness)
    assert keys(found) == ["spare"] and found["still_over"] is True
    assert [key for key in reasons if status(harness, key) == ModelStatus.EVICTED] == ["spare"]


def test_relocated_bases_are_outside_the_budget(harness: Harness, tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    add_base(harness, "away", 30, path=str(outside))
    budget(harness, 1)
    assert cache(harness)["bases"] == [] and free(harness)["evict"] == []
    assert outside.is_dir() and status(harness, "away") == ModelStatus.AVAILABLE


def test_estimate_before_a_download_names_what_would_be_removed(harness: Harness) -> None:
    add_base(harness, "old", 10)
    add_base(harness, "older", 20)
    off = estimate(harness, SIZE)
    assert (off["enabled"], off["over"], off["evict"]) == (False, False, [])
    budget(harness, 2 * SIZE + 500)
    assert (estimate(harness, 100)["over"], estimate(harness, 100)["evict"]) == (False, [])
    found = estimate(harness, SIZE)
    assert (found["over"], found["still_over"], keys(found)) == (True, False, ["older"])
    assert (found["used_bytes"], found["incoming_bytes"], found["freed_bytes"]) == (2 * SIZE, SIZE, SIZE)
    assert harness.client.post("/api/models/base/older/pin", json={"pinned": True}).json()["pinned"] is True
    assert harness.client.post("/api/models/base/old/pin", json={"pinned": True}).status_code == 200
    blocked = estimate(harness, SIZE)
    assert (blocked["evict"], blocked["still_over"]) == ([], True)
    assert status(harness, "older") == ModelStatus.AVAILABLE and not evictions(harness)
    with harness.sessions() as session:
        actions = [event.action for event in session.query(AuditEvent).order_by(AuditEvent.id)]
    assert actions.count("model.pin") == 2 and "settings.model_cache" in actions


def test_removed_base_downloads_again_against_its_saved_list(harness: Harness, hub: Path) -> None:
    folder = Path(installed(harness)["storage_path"])
    keeper = harness.app.state.cache
    assert keeper.woken.is_set()
    age(harness, "tiny", 3)
    budget(harness, 1)
    keeper.woken.clear()
    assert [base.key for base in keeper.run("install").evict] == ["tiny"] and not folder.exists()
    assert (evictions(harness)[0].actor, evictions(harness)[0].detail["trigger"]) == ("system", "install")
    removed = row(harness, "tiny")
    assert removed["availability"]["state"] == "evicted" and removed["can_test"] is False
    assert (removed["health"]["state"], removed["health"]["label"]) == ("evicted", "Removed to free space")
    assert [action["kind"] for action in removed["health"]["actions"]] == ["download_again", "reimport", "remove"]
    assert harness.client.get("/api/models/base/tiny").json()["evicted_at"]
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
    assert keeper.woken.is_set() and harness.client.get("/api/models/base/tiny").json()["evicted_at"] is None
    assert keeper.run("install").evict == ()


def test_removed_import_is_reimported_from_a_folder(harness: Harness, tmp_path: Path) -> None:
    source = tmp_path / "corp"
    source.mkdir()
    for name, data in FILES.items():
        (source / name).write_bytes(data)
    stored = Path(import_folder(harness, "Corp", source)["storage_path"])
    age(harness, "corp", 3)
    budget(harness, 1)
    assert keys(free(harness)) == ["corp"] and not stored.exists()
    removed = row(harness, "corp")
    assert [action["kind"] for action in removed["health"]["actions"]] == ["reimport", "remove"]
    assert str(source) in removed["health"]["detail"]
    assert harness.client.post("/api/models/base/corp/reimport", json={"location": str(source)}).status_code == 202
    assert row(harness, "corp")["availability"]["state"] == "importing"
    assert harness.worker(kinds=["repair"]).run_once()
    assert row(harness, "corp")["availability"]["state"] == "available"
    assert (stored / "model.safetensors").read_bytes() == FILES["model.safetensors"]


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
    assert row(harness, "old")["last_used_at"] and row(harness, "old")["pinned"] is False
