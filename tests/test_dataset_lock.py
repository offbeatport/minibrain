from typing import Any

from tests.conftest import Harness
from tests.test_flow import SLUG, create_on_data, finish, tickets_csv

QUEUED = "Scoring v0 is queued on this dataset; change it once that finishes, or cancel the job."
RUNNING = "Scoring v0 is running on this dataset; change it once that finishes, or cancel the job."


def other_dataset(harness: Harness) -> str:
    files = {"file": ("more.csv", tickets_csv(), "text/csv")}
    source = harness.client.post("/api/sources", files=files).json()
    created = harness.client.post("/api/datasets", json={"name": "More tickets", "source_id": source["id"]})
    assert created.status_code == 201, created.text
    return created.json()["slug"]


def model(harness: Harness) -> dict[str, Any]:
    return harness.client.get(f"/api/models/{SLUG}").json()


def choose(harness: Harness, dataset: str | None) -> Any:
    return harness.client.put(f"/api/models/{SLUG}/dataset", json={"dataset": dataset})


def test_the_dataset_is_locked_while_a_job_scores_or_trains_on_it(harness: Harness) -> None:
    create_on_data(harness)
    current = model(harness)["dataset"]
    other = other_dataset(harness)
    assert model(harness)["dataset_lock"] == QUEUED
    refused = choose(harness, other)
    assert refused.status_code == 409 and refused.json()["detail"] == QUEUED
    assert choose(harness, None).status_code == 409
    assert choose(harness, current).status_code == 200
    assert harness.claim(["eval"]) is not None
    assert model(harness)["dataset_lock"] == RUNNING
    assert choose(harness, other).status_code == 409
    assert model(harness)["dataset"] == current


def test_a_finished_job_unlocks_the_dataset(harness: Harness) -> None:
    create_on_data(harness)
    other = other_dataset(harness)
    finish(harness, "eval", accuracy=0.4)
    assert model(harness)["dataset_lock"] is None
    changed = choose(harness, other)
    assert changed.status_code == 200 and changed.json()["dataset"] == other
