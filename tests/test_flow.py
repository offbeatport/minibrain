import hashlib
from typing import Any

import pytest
from sqlalchemy import select

from minibrain.registry.models import Model, Version
from tests.conftest import LABELS, Harness, fake_adapter, give_data, scored_answers, tickets_csv

pytestmark = pytest.mark.both_stores

SLUG = "support-triage"


def build_dataset(harness: Harness) -> dict[str, Any]:
    response = harness.client.post(f"/api/models/{SLUG}/dataset-versions")
    assert response.status_code == 201, response.text
    return response.json()["dataset_version"]


def create_model(harness: Harness, name: str = "Support Triage") -> dict[str, Any]:
    response = harness.client.post("/api/models", json={"name": name, "preset": "classify", "labels": list(LABELS)})
    assert response.status_code == 201, response.text
    return response.json()


def create_with_dataset(harness: Harness) -> dict[str, Any]:
    create_model(harness)
    give_data(harness, SLUG)
    return build_dataset(harness)


TIMING = {"latency": {"p50_ms": 40.0, "p95_ms": 80.0}, "prompt_tokens": 48, "device": "cpu"}


def create_on_data(harness: Harness, name: str = "Support Triage") -> dict[str, Any]:
    files = {"file": ("tickets.csv", tickets_csv(), "text/csv")}
    source = harness.client.post("/api/sources", files=files).json()
    dataset = harness.client.post("/api/datasets", json={"name": name, "source_id": source["id"]})
    assert dataset.status_code == 201, dataset.text
    created = harness.client.post(
        "/api/models", json={"name": name, "preset": "classify", "dataset": dataset.json()["slug"]}
    )
    assert created.status_code == 201, created.text
    return created.json()


def store_metrics(harness: Harness, slug: str, number: int, metrics: dict[str, Any]) -> None:
    with harness.sessions() as session:
        version = session.scalar(select(Version).join(Model).where(Model.slug == slug, Version.number == number))
        assert version is not None
        version.metrics = metrics
        session.commit()


def finish(harness: Harness, kind: str, accuracy: float = 0.5) -> int:
    claim = harness.claim([kind])
    assert claim is not None, f"no {kind} job queued"
    outputs: dict[str, str] = {}
    result: dict[str, Any] = {"summary": {"epochs": 1}}
    if kind == "train":
        outputs["adapter"] = harness.upload(fake_adapter(), "adapter", "tar", "adapter")
    else:
        result = {"metrics": TIMING, "answers": scored_answers(harness, claim["job_id"], accuracy)}
    body = {"token": claim["token"], "result": result, "outputs": outputs}
    assert harness.internal(f"/jobs/{claim['job_id']}/complete", body).status_code == 204
    return claim["job_id"]


def add_version(harness: Harness, kind: str) -> dict[str, Any]:
    response = harness.client.post(f"/api/models/{SLUG}/versions", json={"kind": kind, "max_rows": 100})
    assert response.status_code == 201
    return response.json()


def deploy(harness: Harness, number: int = 0) -> None:
    response = harness.client.post(f"/api/models/{SLUG}/versions/{number}/promote")
    assert response.status_code == 200, response.text


def add_key(harness: Harness, *models: tuple[str, str], name: str | None = None) -> dict[str, Any]:
    scopes = [{"kind": kind, "key": key} for kind, key in models or [("custom", SLUG)]]
    attempt = 1
    response = harness.client.post("/api/keys", json={"name": name or "ci", "models": scopes})
    while response.status_code == 409 and name is None:
        attempt += 1
        response = harness.client.post("/api/keys", json={"name": f"ci-{attempt}", "models": scopes})
    assert response.status_code == 201, response.text
    return response.json()


def bearer(harness: Harness, *models: tuple[str, str]) -> dict[str, str]:
    return {"Authorization": f"Bearer {add_key(harness, *models)['secret']}"}


def test_upload_guesses_mapping_and_previews(harness: Harness) -> None:
    create_model(harness)
    detail = give_data(harness, SLUG)
    assert detail["mapping"]["input_column"] == "text"
    assert detail["mapping"]["label_column"] == "category"
    assert detail["source"]["rows"] == 200
    preview = harness.client.get(f"/api/models/{SLUG}/preview").json()
    assert preview["quality"]["labels"] == 4
    assert preview["quality"]["empty"] == 0
    assert len(preview["rows"]) == 20


def test_dataset_version_is_taken_from_the_dataset_without_a_job(harness: Harness) -> None:
    dataset_version = create_with_dataset(harness)
    assert dataset_version["counts"] == {"golden": 20, "eval": 30, "shots": 4, "train": 146}
    assert dataset_version["labels"] == ["account", "billing", "bug", "feature"]
    assert (dataset_version["rows"], dataset_version["saved"], dataset_version["dataset"]) == (200, True, SLUG)
    again = build_dataset(harness)
    assert (again["hash"], again["id"]) == (dataset_version["hash"], dataset_version["id"])
    golden = harness.client.get(f"/api/models/{SLUG}/golden").json()
    assert len(golden) == 20
    assert harness.client.get(f"/api/jobs?model={SLUG}&kind=prepare").json()["items"] == []


def test_scored_versions_go_live_only_when_deployed(harness: Harness) -> None:
    create_with_dataset(harness)
    version = add_version(harness, "prompt")
    assert (version["number"], version["status"]) == (1, "evaluating")
    finish(harness, "eval", accuracy=0.4)
    versions = harness.client.get(f"/api/models/{SLUG}/versions").json()
    assert (versions[0]["status"], versions[0]["current"], versions[0]["score"]) == ("ready", False, 0.4)
    assert versions[0]["main_metric"] == "label_accuracy"
    deploy(harness, 1)
    detail = harness.client.get(f"/api/models/{SLUG}").json()
    assert (detail["current_version"], detail["deployed"]) == (1, True)


def test_a_version_goes_live_only_when_it_passes_the_promotion_rule(harness: Harness) -> None:
    create_with_dataset(harness)
    add_version(harness, "prompt")
    finish(harness, "eval", accuracy=0.8)
    deploy(harness, 1)
    add_version(harness, "lora")
    finish(harness, "train")
    assert harness.client.get(f"/api/models/{SLUG}/versions").json()[0]["status"] == "evaluating"
    finish(harness, "eval", accuracy=0.4)
    worse = harness.client.get(f"/api/models/{SLUG}/versions").json()[0]
    assert worse["promotion"]["passed"] is False
    refused = harness.client.post(f"/api/models/{SLUG}/versions/2/promote")
    assert refused.status_code == 409
    assert "label_accuracy 0.4 against 0.8 for v1" in refused.json()["detail"]
    assert harness.client.get(f"/api/models/{SLUG}").json()["current_version"] == 1
    add_version(harness, "lora")
    finish(harness, "train")
    finish(harness, "eval", accuracy=0.9)
    deploy(harness, 3)
    assert harness.client.get(f"/api/models/{SLUG}").json()["current_version"] == 3
    deploy(harness, 1)
    assert harness.client.get(f"/api/models/{SLUG}").json()["current_version"] == 1


def test_a_new_custom_model_can_be_deployed_and_serves_its_base_model(harness: Harness) -> None:
    create_model(harness)
    headers = bearer(harness)
    chat = {"model": SLUG, "messages": [{"role": "user", "content": "hi"}]}
    assert harness.client.post("/v1/chat/completions", headers=headers, json=chat).status_code == 404
    response = harness.client.post(f"/api/models/{SLUG}/deploy", json={"deployed": True})
    assert response.json()["deployed"] is True
    served = harness.client.post("/v1/chat/completions", headers=headers, json=chat)
    assert served.status_code == 200, served.text
    harness.client.post(f"/api/models/{SLUG}/deploy", json={"deployed": False})
    assert harness.client.post("/v1/chat/completions", headers=headers, json=chat).status_code == 404


def test_gateway_routes_by_name_and_version(harness: Harness) -> None:
    create_with_dataset(harness)
    add_version(harness, "prompt")
    finish(harness, "eval", accuracy=0.4)
    add_version(harness, "lora")
    finish(harness, "train")
    finish(harness, "eval", accuracy=0.9)
    harness.client.post(f"/api/models/{SLUG}/versions/2/promote", json={})
    headers = bearer(harness)
    models = harness.client.get("/v1/models", headers=headers).json()
    assert [model["id"] for model in models["data"]] == [SLUG, f"{SLUG}@0", f"{SLUG}@1", f"{SLUG}@2"]
    body = {"model": SLUG, "messages": [{"role": "user", "content": "I was charged twice"}]}
    reply = harness.client.post("/v1/chat/completions", headers=headers, json=body).json()
    assert reply["choices"][0]["message"]["content"] == "billing"
    trained = harness.backend.requests[-1]
    assert trained.adapter is not None
    assert trained.adapter.name == f"{SLUG}-v2"
    assert len(trained.adapter.artifact["id"]) == 64
    assert "billing" not in trained.messages[0]["content"]
    assert [message["role"] for message in trained.messages] == ["system", "user"]
    assert trained.constraint is not None and set(trained.constraint.choices) == set(LABELS)
    harness.client.post("/v1/chat/completions", headers=headers, json=body | {"model": f"{SLUG}@1"})
    prompt_only = harness.backend.requests[-1]
    assert prompt_only.adapter is None
    assert "billing" in prompt_only.messages[0]["content"]
    assert len(prompt_only.messages) == 2 + 2 * len(LABELS)
    harness.flush_logs()
    logged = harness.client.get(f"/api/requests?model={SLUG}").json()["items"]
    assert {item["contract"] for item in logged} == {1}


def test_version_files_list_the_adapter_with_sha256(harness: Harness) -> None:
    create_with_dataset(harness)
    add_version(harness, "prompt")
    finish(harness, "eval")
    add_version(harness, "lora")
    finish(harness, "train")
    prompt_only = harness.client.get(f"/api/models/{SLUG}/versions/1/files").json()
    assert (prompt_only["artifact_id"], prompt_only["files"]) == (None, [])
    trained = harness.client.get(f"/api/models/{SLUG}/versions/2/files").json()
    payload = b'{"r": 16}'
    assert trained["files"] == [
        {"path": "adapter_config.json", "size": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
    ]
    assert len(trained["artifact_id"]) == 64


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
    deploy(harness)
    body = {"model": SLUG, "stream": True, "messages": [{"role": "user", "content": "hi"}]}
    response = harness.client.post("/v1/chat/completions", headers=bearer(harness), json=body)
    assert response.headers["content-type"].startswith("text/event-stream")
    assert '"content": "billing"' in response.text
    assert response.text.rstrip().endswith("data: [DONE]")


def test_playground_answers_with_the_label(harness: Harness) -> None:
    create_with_dataset(harness)
    add_version(harness, "prompt")
    ask = {"model": SLUG, "messages": [{"role": "user", "content": "charged twice"}]}
    assert harness.client.post("/api/playground/chat/completions", json=ask).status_code == 404
    finish(harness, "eval", accuracy=0.4)
    deploy(harness, 1)
    reply = harness.client.post("/api/playground/chat/completions", json=ask).json()
    assert (reply["choices"][0]["message"]["content"], reply["model"]) == ("billing", SLUG)
    assert harness.backend.requests[-1].route == SLUG


def test_cancel_queued_job_and_delete_guard(harness: Harness) -> None:
    create_with_dataset(harness)
    add_version(harness, "lora")
    job = harness.client.get(f"/api/jobs?model={SLUG}&kind=train").json()["items"][0]
    assert harness.client.delete(f"/api/models/{SLUG}").status_code == 409
    assert harness.client.post(f"/api/jobs/{job['id']}/cancel").json()["status"] == "cancelled"
    assert harness.client.get(f"/api/models/{SLUG}/versions").json()[0]["status"] == "failed"
    assert harness.claim(["train"]) is None
    assert harness.client.delete(f"/api/models/{SLUG}").status_code == 202


def test_bad_sql_is_rejected(harness: Harness) -> None:
    create_with_dataset(harness)
    response = harness.client.put(f"/api/models/{SLUG}/mapping", json={"sql": "SELECT nope FROM source"})
    assert response.status_code == 422


def test_recent_jobs_span_models(harness: Harness) -> None:
    create_with_dataset(harness)
    add_version(harness, "prompt")
    finish(harness, "eval", accuracy=0.4)
    deploy(harness, 1)
    create_model(harness, "Other")
    jobs = harness.client.get("/api/jobs?limit=5").json()["items"]
    assert {(job["model"], job["model_name"]) for job in jobs} == {(SLUG, "Support Triage")}
    rows = {item["key"]: item for item in harness.client.get("/api/models", params={"kind": "custom"}).json()}
    assert set(rows) == {SLUG, "other"}
    assert rows[SLUG]["score"] == 0.4
    assert rows[SLUG]["metric"] == "label_accuracy"
    assert rows["other"]["score"] is None
    assert rows["other"]["base_model"] == "qwen3-0.6b"


def test_system_settings_and_ops(harness: Harness) -> None:
    system = harness.client.get("/api/system").json()
    assert system["device"]["inference"] in {"cuda", "mps", "cpu"}
    assert system["device"]["cpu_count"] >= 1
    assert system["loaded"] == []
    settings = harness.client.get("/api/settings").json()
    assert settings["splits"]["golden"] == 50
    assert harness.client.get("/healthz").json() == {"status": "ok"}
    assert harness.client.get("/readyz").json() == {"status": "ready"}
    assert harness.client.get("/metrics").status_code == 404


def test_internal_endpoints_need_the_worker_token(harness: Harness) -> None:
    body = {"worker": {"id": "w", "host": "h", "kinds": ["eval"], "gpus": 1}, "wait": 0}
    assert harness.client.post("/internal/worker/claim", json=body).status_code == 401
    bad = {"Authorization": "Bearer nope"}
    assert harness.client.post("/internal/worker/claim", json=body, headers=bad).status_code == 401


def test_a_model_name_needs_a_letter_or_number_and_must_be_free(harness: Harness) -> None:
    blank = harness.client.post(
        "/api/models", json={"preset": "classify", "labels": ["billing", "bug"], "name": "**** "}
    )
    assert blank.status_code == 422 and "letter or number" in blank.json()["detail"]
    assert create_model(harness)["slug"] == SLUG
    taken = harness.client.post(
        "/api/models", json={"name": "support triage", "preset": "classify", "labels": list(LABELS)}
    )
    assert taken.status_code == 409 and "support triage" in taken.json()["detail"]
    same_address = harness.client.post(
        "/api/models", json={"name": "support  triage!", "preset": "classify", "labels": list(LABELS)}
    )
    assert same_address.status_code == 201 and same_address.json()["slug"] == f"{SLUG}-2"
