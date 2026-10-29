from typing import Any

from minibrain import worker
from minibrain.registry.models import Job, Version
from tests.conftest import Harness, tickets_csv

SLUG = "support-triage"


def create_with_dataset(harness: Harness) -> dict[str, Any]:
    harness.client.post("/api/minibrains", json={"name": "Support Triage"})
    files = {"file": ("tickets.csv", tickets_csv(), "text/csv")}
    harness.client.post(f"/api/minibrains/{SLUG}/source", files=files)
    return harness.client.post(f"/api/minibrains/{SLUG}/snapshots").json()


def finish_job(harness: Harness, job_id: int, accuracy: float | None = None) -> int | None:
    sessions = harness.sessions
    if accuracy is not None:
        with sessions() as session:
            job = session.get(Job, job_id)
            assert job is not None
            version = session.get(Version, job.version_id)
            assert version is not None
            version.metrics = {"eval": {"examples": 30, "accuracy": accuracy, "macro_f1": accuracy, "invalid_rate": 0}}
            session.commit()
    return worker.finish(sessions, harness.settings, job_id, 0)


def add_version(harness: Harness, kind: str) -> dict[str, Any]:
    response = harness.client.post(f"/api/minibrains/{SLUG}/versions", json={"kind": kind, "max_rows": 100})
    assert response.status_code == 201
    return response.json()


def bearer(harness: Harness) -> dict[str, str]:
    secret = harness.client.post(f"/api/minibrains/{SLUG}/keys", json={"name": "ci"}).json()["secret"]
    return {"Authorization": f"Bearer {secret}"}


def test_upload_guesses_mapping_and_previews(harness: Harness) -> None:
    harness.client.post("/api/minibrains", json={"name": "Support Triage"})
    files = {"file": ("tickets.csv", tickets_csv(), "text/csv")}
    detail = harness.client.post(f"/api/minibrains/{SLUG}/source", files=files).json()
    assert detail["mapping"]["input_column"] == "text"
    assert detail["mapping"]["label_column"] == "category"
    assert detail["source"]["rows"] == 200
    preview = harness.client.get(f"/api/minibrains/{SLUG}/preview").json()
    assert preview["quality"]["labels"] == 4
    assert preview["quality"]["empty"] == 0
    assert len(preview["rows"]) == 20


def test_snapshot_splits(harness: Harness) -> None:
    snapshot = create_with_dataset(harness)
    assert snapshot["counts"] == {"golden": 20, "eval": 30, "shots": 4, "train": 146}
    assert snapshot["labels"] == ["account", "billing", "bug", "feature"]
    again = harness.client.post(f"/api/minibrains/{SLUG}/snapshots").json()
    assert again["hash"] == snapshot["hash"]


def test_prompt_only_version_becomes_current(harness: Harness) -> None:
    create_with_dataset(harness)
    version = add_version(harness, "prompt")
    assert version["status"] == "evaluating"
    assert finish_job(harness, harness.queued[-1], accuracy=0.4) is None
    versions = harness.client.get(f"/api/minibrains/{SLUG}/versions").json()
    assert versions[0]["status"] == "ready"
    assert versions[0]["current"] is True


def test_training_queues_eval_and_promotion_is_gated(harness: Harness) -> None:
    create_with_dataset(harness)
    add_version(harness, "prompt")
    finish_job(harness, harness.queued[-1], accuracy=0.8)
    add_version(harness, "lora")
    eval_job = finish_job(harness, harness.queued[-1])
    assert eval_job is not None
    finish_job(harness, eval_job, accuracy=0.4)
    blocked = harness.client.post(f"/api/minibrains/{SLUG}/versions/1/promote", json={"override": False})
    assert blocked.status_code == 409
    forced = harness.client.post(f"/api/minibrains/{SLUG}/versions/1/promote", json={"override": True})
    assert forced.json()["current_version"] == 1


def test_gateway_routes_by_name_and_version(harness: Harness) -> None:
    create_with_dataset(harness)
    add_version(harness, "prompt")
    finish_job(harness, harness.queued[-1], accuracy=0.4)
    add_version(harness, "lora")
    finish_job(harness, finish_job(harness, harness.queued[-1]) or 0, accuracy=0.9)
    harness.client.post(f"/api/minibrains/{SLUG}/versions/1/promote", json={})
    headers = bearer(harness)
    models = harness.client.get("/v1/models", headers=headers).json()
    assert [model["id"] for model in models["data"]] == [SLUG, f"{SLUG}@0", f"{SLUG}@1"]
    body = {"model": SLUG, "messages": [{"role": "user", "content": "I was charged twice"}]}
    reply = harness.client.post("/v1/chat/completions", headers=headers, json=body).json()
    assert reply["choices"][0]["message"]["content"] == "billing"
    trained = harness.backend.requests[-1]
    assert trained.adapter is not None
    assert "billing" not in trained.messages[0]["content"]
    harness.client.post("/v1/chat/completions", headers=headers, json=body | {"model": f"{SLUG}@0"})
    prompt_only = harness.backend.requests[-1]
    assert prompt_only.adapter is None
    assert "billing" in prompt_only.messages[0]["content"]


def test_gateway_rejects_bad_keys_and_unknown_models(harness: Harness) -> None:
    create_with_dataset(harness)
    add_version(harness, "prompt")
    finish_job(harness, harness.queued[-1], accuracy=0.4)
    body = {"model": SLUG, "messages": [{"role": "user", "content": "hi"}]}
    assert harness.client.post("/v1/chat/completions", json=body).status_code == 401
    wrong = {"Authorization": "Bearer mb_not-a-key"}
    assert harness.client.post("/v1/chat/completions", headers=wrong, json=body).status_code == 401
    headers = bearer(harness)
    unknown = harness.client.post("/v1/chat/completions", headers=headers, json=body | {"model": "other"})
    assert unknown.status_code == 404


def test_gateway_streams(harness: Harness) -> None:
    create_with_dataset(harness)
    add_version(harness, "prompt")
    finish_job(harness, harness.queued[-1], accuracy=0.4)
    body = {"model": SLUG, "stream": True, "messages": [{"role": "user", "content": "hi"}]}
    response = harness.client.post("/v1/chat/completions", headers=bearer(harness), json=body)
    assert response.headers["content-type"].startswith("text/event-stream")
    assert '"content": "billing"' in response.text
    assert response.text.rstrip().endswith("data: [DONE]")


def test_playground_parses_label(harness: Harness) -> None:
    create_with_dataset(harness)
    add_version(harness, "prompt")
    assert harness.client.post(f"/api/minibrains/{SLUG}/complete", json={"text": "x"}).status_code == 409
    finish_job(harness, harness.queued[-1], accuracy=0.4)
    reply = harness.client.post(f"/api/minibrains/{SLUG}/complete", json={"text": "charged twice"}).json()
    assert reply["label"] == "billing"
    assert reply["model"] == f"{SLUG}@0"


def test_cancel_and_delete_guard(harness: Harness) -> None:
    create_with_dataset(harness)
    add_version(harness, "lora")
    job_id = harness.queued[-1]
    assert harness.client.delete(f"/api/minibrains/{SLUG}").status_code == 409
    assert harness.client.post(f"/api/jobs/{job_id}/cancel").json()["status"] == "cancelling"
    assert worker.start(harness.sessions, job_id) is None
    assert harness.client.get(f"/api/minibrains/{SLUG}/jobs").json()[0]["status"] == "cancelled"
    assert harness.client.delete(f"/api/minibrains/{SLUG}").status_code == 204


def test_bad_sql_is_rejected(harness: Harness) -> None:
    create_with_dataset(harness)
    response = harness.client.put(f"/api/minibrains/{SLUG}/mapping", json={"sql": "SELECT nope FROM source"})
    assert response.status_code == 422
