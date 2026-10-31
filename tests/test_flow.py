from typing import Any

from tests.conftest import Harness, fake_adapter, tickets_csv

SLUG = "support-triage"


def build_dataset(harness: Harness) -> dict[str, Any]:
    job = harness.client.post(f"/api/minibrains/{SLUG}/snapshots")
    assert job.status_code == 202
    assert harness.worker(kinds=["prepare"]).run_once()
    return harness.client.get(f"/api/minibrains/{SLUG}").json()["snapshot"]


def create_with_dataset(harness: Harness) -> dict[str, Any]:
    harness.client.post("/api/minibrains", json={"name": "Support Triage"})
    files = {"file": ("tickets.csv", tickets_csv(), "text/csv")}
    harness.client.post(f"/api/minibrains/{SLUG}/source", files=files)
    return build_dataset(harness)


def finish(harness: Harness, kind: str, accuracy: float = 0.5) -> int:
    claim = harness.claim([kind])
    assert claim is not None, f"no {kind} job queued"
    outputs: dict[str, str] = {}
    result: dict[str, Any] = {"summary": {"epochs": 1}}
    if kind == "train":
        outputs["adapter"] = harness.upload(fake_adapter(), "adapter", "tar", "adapter")
    else:
        result = {"metrics": {"eval": {"examples": 30, "accuracy": accuracy, "macro_f1": accuracy, "invalid_rate": 0}}}
    body = {"token": claim["token"], "result": result, "outputs": outputs}
    assert harness.internal(f"/jobs/{claim['job_id']}/complete", body).status_code == 204
    return claim["job_id"]


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


def test_snapshot_is_built_by_a_prepare_job(harness: Harness) -> None:
    snapshot = create_with_dataset(harness)
    assert snapshot["counts"] == {"golden": 20, "eval": 30, "shots": 4, "train": 146}
    assert snapshot["labels"] == ["account", "billing", "bug", "feature"]
    again = build_dataset(harness)
    assert again["hash"] == snapshot["hash"]
    golden = harness.client.get(f"/api/minibrains/{SLUG}/golden").json()
    assert len(golden) == 20
    prepare = harness.client.get(f"/api/jobs?minibrain={SLUG}&kind=prepare").json()
    assert [job["status"] for job in prepare] == ["succeeded", "succeeded"]


def test_prompt_only_version_becomes_current(harness: Harness) -> None:
    create_with_dataset(harness)
    version = add_version(harness, "prompt")
    assert version["status"] == "evaluating"
    finish(harness, "eval", accuracy=0.4)
    versions = harness.client.get(f"/api/minibrains/{SLUG}/versions").json()
    assert versions[0]["status"] == "ready"
    assert versions[0]["current"] is True


def test_training_queues_eval_and_promotion_is_gated(harness: Harness) -> None:
    create_with_dataset(harness)
    add_version(harness, "prompt")
    finish(harness, "eval", accuracy=0.8)
    add_version(harness, "lora")
    finish(harness, "train")
    assert harness.client.get(f"/api/minibrains/{SLUG}/versions").json()[0]["status"] == "evaluating"
    finish(harness, "eval", accuracy=0.4)
    blocked = harness.client.post(f"/api/minibrains/{SLUG}/versions/1/promote", json={"override": False})
    assert blocked.status_code == 409
    forced = harness.client.post(f"/api/minibrains/{SLUG}/versions/1/promote", json={"override": True})
    assert forced.json()["current_version"] == 1


def test_gateway_routes_by_name_and_version(harness: Harness) -> None:
    create_with_dataset(harness)
    add_version(harness, "prompt")
    finish(harness, "eval", accuracy=0.4)
    add_version(harness, "lora")
    finish(harness, "train")
    finish(harness, "eval", accuracy=0.9)
    harness.client.post(f"/api/minibrains/{SLUG}/versions/1/promote", json={})
    headers = bearer(harness)
    models = harness.client.get("/v1/models", headers=headers).json()
    assert [model["id"] for model in models["data"]] == [SLUG, f"{SLUG}@0", f"{SLUG}@1"]
    body = {"model": SLUG, "messages": [{"role": "user", "content": "I was charged twice"}]}
    reply = harness.client.post("/v1/chat/completions", headers=headers, json=body).json()
    assert reply["choices"][0]["message"]["content"] == "billing"
    trained = harness.backend.requests[-1]
    assert trained.adapter is not None
    assert trained.adapter.name == f"{SLUG}-v1"
    assert len(trained.adapter.artifact["id"]) == 64
    assert "billing" not in trained.messages[0]["content"]
    harness.client.post("/v1/chat/completions", headers=headers, json=body | {"model": f"{SLUG}@0"})
    prompt_only = harness.backend.requests[-1]
    assert prompt_only.adapter is None
    assert "billing" in prompt_only.messages[0]["content"]


def test_gateway_rejects_bad_keys_and_unknown_models(harness: Harness) -> None:
    create_with_dataset(harness)
    add_version(harness, "prompt")
    finish(harness, "eval", accuracy=0.4)
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
    finish(harness, "eval", accuracy=0.4)
    body = {"model": SLUG, "stream": True, "messages": [{"role": "user", "content": "hi"}]}
    response = harness.client.post("/v1/chat/completions", headers=bearer(harness), json=body)
    assert response.headers["content-type"].startswith("text/event-stream")
    assert '"content": "billing"' in response.text
    assert response.text.rstrip().endswith("data: [DONE]")


def test_playground_parses_label(harness: Harness) -> None:
    create_with_dataset(harness)
    add_version(harness, "prompt")
    assert harness.client.post(f"/api/minibrains/{SLUG}/complete", json={"text": "x"}).status_code == 409
    finish(harness, "eval", accuracy=0.4)
    reply = harness.client.post(f"/api/minibrains/{SLUG}/complete", json={"text": "charged twice"}).json()
    assert reply["label"] == "billing"
    assert reply["model"] == f"{SLUG}@0"


def test_cancel_queued_job_and_delete_guard(harness: Harness) -> None:
    create_with_dataset(harness)
    add_version(harness, "lora")
    job = harness.client.get(f"/api/jobs?minibrain={SLUG}&kind=train").json()[0]
    assert harness.client.delete(f"/api/minibrains/{SLUG}").status_code == 409
    assert harness.client.post(f"/api/jobs/{job['id']}/cancel").json()["status"] == "cancelled"
    assert harness.client.get(f"/api/minibrains/{SLUG}/versions").json()[0]["status"] == "failed"
    assert harness.claim(["train"]) is None
    assert harness.client.delete(f"/api/minibrains/{SLUG}").status_code == 204


def test_bad_sql_is_rejected(harness: Harness) -> None:
    create_with_dataset(harness)
    response = harness.client.put(f"/api/minibrains/{SLUG}/mapping", json={"sql": "SELECT nope FROM source"})
    assert response.status_code == 422


def test_recent_jobs_span_minibrains(harness: Harness) -> None:
    create_with_dataset(harness)
    add_version(harness, "prompt")
    finish(harness, "eval", accuracy=0.4)
    harness.client.post("/api/minibrains", json={"name": "Other"})
    jobs = harness.client.get("/api/jobs?limit=5").json()
    assert {(job["minibrain"], job["minibrain_name"]) for job in jobs} == {(SLUG, "Support Triage")}
    summaries = {item["slug"]: item for item in harness.client.get("/api/minibrains").json()}
    assert summaries[SLUG]["current_accuracy"] == 0.4
    assert summaries["other"]["current_accuracy"] is None
    assert summaries["other"]["base_model"] == "qwen3-0.6b"


def test_system_settings_and_ops(harness: Harness) -> None:
    system = harness.client.get("/api/system").json()
    assert system["device"]["inference"] in {"cuda", "mps", "cpu"}
    assert system["device"]["cpu_count"] >= 1
    assert "torch" in system["libraries"]
    assert system["loaded"] == []
    settings = harness.client.get("/api/settings").json()
    assert settings["default_base_model"] == "qwen3-0.6b"
    assert settings["base_models"][0]["license"] == "Apache-2.0"
    assert settings["splits"]["golden"] == 50
    assert harness.client.get("/healthz").json() == {"status": "ok"}
    assert harness.client.get("/readyz").json() == {"status": "ready"}
    assert "minibrain_queue_oldest_seconds" in harness.client.get("/metrics").text


def test_internal_endpoints_need_the_worker_token(harness: Harness) -> None:
    body = {"worker": {"id": "w", "host": "h", "kinds": ["eval"], "gpus": 1}, "wait": 0}
    assert harness.client.post("/internal/worker/claim", json=body).status_code == 401
    bad = {"Authorization": "Bearer nope"}
    assert harness.client.post("/internal/worker/claim", json=body, headers=bad).status_code == 401
