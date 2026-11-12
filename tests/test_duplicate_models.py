from typing import Any

import pytest
from sqlalchemy import select

from minibrain.auth.roles import Role
from minibrain.registry.files import store_for
from minibrain.registry.models import AuditEvent, Model, Version
from tests.conftest import Harness
from tests.test_flow import SLUG, add_version, create_with_dataset, deploy, finish

pytestmark = pytest.mark.both_stores

COPY = "support-triage-copy"
INSTRUCTIONS = "Answer with the team that owns the ticket."


def live_source(harness: Harness) -> int:
    create_with_dataset(harness)
    harness.client.put(f"/api/models/{SLUG}/instructions", json={"instructions": INSTRUCTIONS})
    harness.client.patch(f"/api/models/{SLUG}", json={"description": "Routes tickets", "tags": ["support"]})
    add_version(harness, "lora")
    job = finish(harness, "train")
    finish(harness, "eval", accuracy=0.9)
    deploy(harness, 1)
    return job


def duplicate(harness: Harness, name: str = "Support Triage copy", slug: str = SLUG) -> Any:
    return harness.client.post(f"/api/models/{slug}/duplicate", json={"name": name})


def versions(harness: Harness, slug: str) -> dict[int, dict[str, Any]]:
    return {item["number"]: item for item in harness.client.get(f"/api/models/{slug}/versions").json()}


def adapters(harness: Harness, slug: str) -> dict[int, str | None]:
    with harness.sessions() as session:
        query = select(Version.number, Version.adapter_artifact_id).join(Model).where(Model.slug == slug)
        return {number: artifact for number, artifact in session.execute(query)}


def events(harness: Harness, action: str) -> list[AuditEvent]:
    with harness.sessions() as session:
        return list(session.scalars(select(AuditEvent).where(AuditEvent.action == action)))


def test_duplicating_copies_settings_data_and_the_live_version_as_v1(harness: Harness) -> None:
    job = live_source(harness)
    created = duplicate(harness)
    assert created.status_code == 201, created.text
    copy = created.json()
    source = harness.client.get(f"/api/models/{SLUG}").json()
    assert copy["slug"] == COPY and copy["deployed"] is False
    for field in ("preset", "base_model", "contract", "instructions", "promotion", "graders", "dataset"):
        assert copy[field] == source[field], field
    with harness.sessions() as session:
        copied = session.scalars(select(Model).where(Model.slug == COPY)).one()
        assert (copied.description, copied.tags) == ("Routes tickets", ["support"])
    found = versions(harness, COPY)
    assert sorted(found) == [0, 1]
    original = versions(harness, SLUG)[1]
    v1 = found[1]
    assert (v1["kind"], v1["status"], v1["current"], v1["live_at"]) == ("lora", "ready", False, None)
    assert v1["duplicated_from"] == {"slug": SLUG, "name": "Support Triage", "number": 1, "job": job}
    for field in ("score", "recipe", "dataset_version_id", "held_out", "instructions", "contract"):
        assert v1[field] == original[field], field
    assert adapters(harness, COPY)[1] == adapters(harness, SLUG)[1] is not None
    card = harness.client.get(f"/api/models/{COPY}/versions/1/card").json()["card"]
    assert card["training"]["duplicated_from"] == {"slug": SLUG, "name": "Support Triage", "number": 1}
    assert card["training"]["run"]["job_id"] == job
    [event] = events(harness, "model.duplicate")
    assert (event.target, event.detail["source"], event.detail["version"]) == (COPY, SLUG, 1)


def test_the_latest_ready_version_is_copied_when_none_is_live(harness: Harness) -> None:
    create_with_dataset(harness)
    add_version(harness, "lora")
    finish(harness, "train")
    finish(harness, "eval", accuracy=0.9)
    assert duplicate(harness).status_code == 201
    assert versions(harness, COPY)[1]["duplicated_from"]["number"] == 1


def test_deleting_the_original_keeps_the_copys_adapter(harness: Harness) -> None:
    live_source(harness)
    assert duplicate(harness).status_code == 201
    shared = adapters(harness, COPY)[1]
    assert shared is not None
    assert harness.client.delete(f"/api/models/{SLUG}", params={"undeploy": True}).status_code == 202
    harness.settle()
    assert harness.client.get(f"/api/models/{SLUG}").status_code == 404
    assert store_for(harness.settings).has(shared)
    files = harness.client.get(f"/api/models/{COPY}/versions/1/files").json()
    assert files["artifact_id"] == shared and files["files"]
    assert harness.client.post(f"/api/models/{COPY}/versions/1/promote").status_code == 200


def test_deleting_the_copy_keeps_the_originals_adapter(harness: Harness) -> None:
    live_source(harness)
    assert duplicate(harness).status_code == 201
    shared = adapters(harness, SLUG)[1]
    assert shared is not None
    finish(harness, "eval")
    assert harness.client.delete(f"/api/models/{COPY}").status_code == 202
    harness.settle()
    assert store_for(harness.settings).has(shared)


def test_a_taken_name_or_a_source_being_deleted_is_refused(harness: Harness) -> None:
    create_with_dataset(harness)
    assert duplicate(harness, "Support Triage").status_code == 409
    assert duplicate(harness, "support triage!").json()["slug"] == f"{SLUG}-2"
    assert duplicate(harness).status_code == 201
    assert duplicate(harness).status_code == 409
    assert harness.client.delete(f"/api/models/{SLUG}").status_code == 202
    refused = duplicate(harness, "Another copy")
    assert refused.status_code == 409 and "being deleted" in refused.json()["detail"]
    assert duplicate(harness, "Missing", slug="nope").status_code == 404


def test_only_builders_duplicate(harness: Harness) -> None:
    create_with_dataset(harness)
    body = {"name": "Viewer copy"}
    assert harness.person(Role.VIEWER).post(f"/api/models/{SLUG}/duplicate", json=body).status_code == 403
    assert harness.person(Role.BUILDER).post(f"/api/models/{SLUG}/duplicate", json=body).status_code == 201
    [event] = events(harness, "model.duplicate")
    assert event.actor == "builder@example.com" and event.detail["version"] == 0
