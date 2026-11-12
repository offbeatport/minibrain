import hashlib
from datetime import timedelta
from typing import Any

from minibrain.registry.models import BaseModel, BaseModelStatus, now
from tests.conftest import Harness


def add_base(harness: Harness, key: str, days: float) -> None:
    folder = harness.settings.home / "models" / key
    folder.mkdir(parents=True)
    data = key.encode().ljust(3000, b"x")
    (folder / "model.safetensors").write_bytes(data)
    files = [{"path": "model.safetensors", "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}]
    with harness.sessions() as session:
        moment = now() - timedelta(days=days)
        session.add(
            BaseModel(
                id=key,
                source="import",
                name=key.title(),
                status=BaseModelStatus.AVAILABLE,
                files=files,
                size_bytes=len(data),
                created_at=moment,
                last_used_at=moment,
            )
        )
        session.commit()


def row(harness: Harness, key: str) -> dict[str, Any]:
    return next(item for item in harness.client.get("/api/models").json() if item["key"] == key)


def test_loading_or_testing_a_base_marks_it_used(harness: Harness) -> None:
    add_base(harness, "old", 10)
    add_base(harness, "older", 20)
    body = {"id": "e1", "host": "gpu-1", "url": "http://gpu-1:9000", "base_model": "older", "engine": "mlx"}
    announced = harness.client.post(
        "/internal/gateway/engines", json=body | {"state": "ready"}, headers=harness.gateway_headers
    )
    assert announced.status_code == 204
    assert harness.client.post("/api/models/old/test", json={"text": "hi"}).status_code == 200
    with harness.sessions() as session:
        moments = [model.last_used_at for model in session.query(BaseModel)]
    assert all(moment is not None and now() - moment < timedelta(minutes=1) for moment in moments)
    assert row(harness, "old")["last_used_at"]
