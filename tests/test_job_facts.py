from typing import Any

from sqlalchemy import select

from minibrain.registry.models import BaseModel, CatalogVariant, Job, JobKind, JobStatus
from tests.conftest import Harness, fake_adapter
from tests.test_flow import SLUG, add_version, create_with_dataset, store_metrics
from tests.test_job_paging import add_jobs, ids, model_id, page

PLANNED = {"strategy": "qlora", "precision": "bf16", "rank": 32, "epochs": 3, "learning_rate": 1e-4, "batch": 8}


def training_job(harness: Harness) -> dict[str, Any]:
    create_with_dataset(harness)
    add_version(harness, "lora")
    claim = harness.claim([JobKind.TRAIN])
    assert claim is not None
    return claim


def post_start(harness: Harness, claim: dict[str, Any]) -> None:
    data = {"recipe": PLANNED | {"seq_len": 512, "overrides": ["rank", "epochs"]}, "examples": 180, "held_out": 20}
    event = {"kind": "event", "name": "train.start", "level": "info", "message": "Training", "data": data}
    body = {"token": claim["token"], "events": [event]}
    assert harness.internal(f"/jobs/{claim['job_id']}/events", body).status_code == 204


def complete(harness: Harness, claim: dict[str, Any]) -> None:
    outputs = {"adapter": harness.upload(fake_adapter(), "adapter", "tar", "adapter")}
    summary = PLANNED | {"examples": 180, "overrides": ["rank", "epochs"]}
    body = {"token": claim["token"], "result": {"summary": summary}, "outputs": outputs}
    assert harness.internal(f"/jobs/{claim['job_id']}/complete", body).status_code == 204


def detail(harness: Harness, job_id: int) -> dict[str, Any]:
    response = harness.client.get(f"/api/jobs/{job_id}")
    assert response.status_code == 200, response.text
    return response.json()


def test_a_queued_training_job_shows_its_data_and_the_requested_settings(harness: Harness) -> None:
    claim = training_job(harness)
    found = detail(harness, claim["job_id"])
    setup = found["setup"]
    assert setup["dataset"] == SLUG and setup["dataset_version"] == 1 and setup["dataset_rows"] > 0
    assert setup["version_kind"] == "lora" and setup["base_model"]
    training = setup["training"]
    assert training["method"] == "sft" and training["planned"] is False
    assert training["rank"] == 16 and training["examples"] is None
    assert found["method"] == "sft" and found["strategy"] is None and found["rank"] == 16


def test_the_worker_plan_replaces_the_request_once_training_starts(harness: Harness) -> None:
    claim = training_job(harness)
    post_start(harness, claim)
    training = detail(harness, claim["job_id"])["setup"]["training"]
    assert training["planned"] is True and training["strategy"] == "qlora" and training["precision"] == "bf16"
    assert training["rank"] == 32 and training["epochs"] == 3 and training["seq_len"] == 512
    assert training["examples"] == 180 and training["held_out"] == 20 and training["changed"] == ["rank", "epochs"]


def test_listed_training_jobs_carry_method_adapter_and_the_version_score(harness: Harness) -> None:
    claim = training_job(harness)
    complete(harness, claim)
    metric = harness.client.get(f"/api/models/{SLUG}/versions").json()[0]["main_metric"]
    store_metrics(harness, SLUG, 1, {"eval": {"examples": 20, "scores": [{"metric": metric, "value": 0.85}]}})
    listed = next(item for item in page(harness, "kind=train")["items"] if item["id"] == claim["job_id"])
    assert listed["method"] == "sft" and listed["strategy"] == "qlora" and listed["rank"] == 32
    assert listed["score"] == 0.85
    others = [item for item in page(harness)["items"] if item["kind"] != "train"]
    assert all(item["method"] is None and item["strategy"] is None for item in others)


def test_method_filter_keeps_training_jobs_only(harness: Harness) -> None:
    owner = model_id(harness, "Alpha")
    trained = add_jobs(harness, 2, JobKind.TRAIN, owner)
    add_jobs(harness, 3, JobKind.EVAL, owner)
    add_jobs(harness, 1, JobKind.DOWNLOAD)
    assert sorted(ids(page(harness, "method=sft"))) == trained
    assert ids(page(harness, "method=dpo")) == []
    assert page(harness, "method=sft&method=dpo")["total"] == 2


def test_facets_count_kinds_without_the_kind_filter(harness: Harness) -> None:
    owner = model_id(harness, "Alpha")
    add_jobs(harness, 2, JobKind.TRAIN, owner, JobStatus.FAILED)
    add_jobs(harness, 3, JobKind.EVAL, owner)
    add_jobs(harness, 1, JobKind.DOWNLOAD, status=JobStatus.FAILED)
    facets = harness.client.get("/api/jobs/facets?kind=train&status=failed").json()
    assert facets["total"] == 2
    assert facets["kinds"] == {"train": 2, "download": 1}
    assert facets["statuses"] == {"failed": 2}


def test_base_model_jobs_name_the_base_and_its_variant(harness: Harness) -> None:
    job_id = add_jobs(harness, 1, JobKind.DOWNLOAD)[0]
    with harness.sessions() as session:
        variant = session.scalars(select(CatalogVariant).order_by(CatalogVariant.id)).first()
        assert variant is not None
        session.add(
            BaseModel(
                id="downloaded",
                source="download",
                name="Downloaded base",
                status="downloading",
                catalog_id=variant.catalog_id,
                variant_id=variant.id,
                revision="abc1234def",
                size_bytes=16_000_000_000,
            )
        )
        job = session.get(Job, job_id)
        assert job is not None
        job.base_model_id = job.base_model_key = "downloaded"
        precision = variant.precision.upper()
        publisher = variant.model.provider
        session.commit()
    listed = page(harness, "kind=download")["items"][0]
    assert listed["base_model_name"] == "Downloaded base" and listed["variant"] == precision
    assert listed["publisher"] == publisher
    setup = detail(harness, job_id)["setup"]
    assert setup["base_model"] == "downloaded" and setup["base_model_name"] == "Downloaded base"
    assert setup["variant"] == precision and setup["revision"] == "abc1234def" and setup["training"] is None
