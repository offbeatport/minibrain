from datetime import timedelta
from pathlib import Path
from typing import Any

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, insert, select
from sqlalchemy.orm import sessionmaker

from minibrain.gateway.logs import LogEntry, database_sink
from minibrain.registry.db import MIGRATIONS, make_engine
from minibrain.registry.models import AuditEvent, Job, Model, RequestLog, ReservedName, now
from tests.conftest import ADMIN_EMAIL, Harness, blank_dataset
from tests.test_flow import SLUG, add_key, create_model
from tests.test_gateway import CHAT, servable
from tests.test_model_page import import_base
from tests.test_teardown import add_base

LABELS = ["billing", "bug"]


def create(harness: Harness, name: str, **extra: Any) -> Any:
    return harness.client.post(
        "/api/models",
        json={"dataset": blank_dataset(harness.client), "name": name, "preset": "classify", "labels": LABELS} | extra,
    )


def delete(harness: Harness, name: str, path: str = "/api/models") -> None:
    response = harness.client.delete(f"{path}/{name}", params={"undeploy": True})
    assert response.status_code in (202, 204), response.text
    harness.settle()


def model_id(harness: Harness, slug: str) -> int:
    with harness.sessions() as session:
        return session.scalars(select(Model.id).where(Model.slug == slug)).one()


def log(harness: Harness, model: int | None, name: str, status: int = 200) -> None:
    entry = LogEntry(at=now(), key_id=None, model_id=model, model=name, version=0, status=status, latency_ms=5.0)
    database_sink(harness.sessions)([entry])


def job(harness: Harness, slug: str) -> None:
    with harness.sessions() as session:
        model = session.scalars(select(Model).where(Model.slug == slug)).one()
        session.add(Job(kind="eval", status="succeeded", model_id=model.id, model_slug=slug, model_name=model.name))
        session.commit()


def requests(harness: Harness, **params: Any) -> list[str]:
    found = harness.client.get("/api/requests", params=params).json()["items"]
    return sorted(f"{item['model_key']}:{item['deleted']}" for item in found)


def facets(harness: Harness, path: str) -> Any:
    response = harness.client.get(path)
    assert response.status_code == 200, response.text
    return response.json()


def today() -> str:
    return f"{now():%Y-%m-%d}"


def test_a_deleted_name_is_reserved_and_the_next_model_gets_a_suffix(harness: Harness) -> None:
    create_model(harness)
    delete(harness, SLUG)
    with harness.sessions() as session:
        reserved = session.get(ReservedName, SLUG)
        assert reserved is not None
        assert (reserved.kind, reserved.model_name, reserved.deleted_by) == ("custom", "Support Triage", ADMIN_EMAIL)
    preview = harness.client.get("/api/models/name", params={"name": "Support Triage"}).json()
    assert (preview["api_name"], preview["reserved"]["name"]) == (f"{SLUG}-2", SLUG)
    created = create(harness, "Support Triage")
    assert created.status_code == 201 and created.json()["slug"] == f"{SLUG}-2"
    again = create(harness, "Support triage two", api_name=f"{SLUG}-3")
    assert again.status_code == 201 and again.json()["slug"] == f"{SLUG}-3"
    assert create(harness, "Support Triage").status_code == 409
    info = harness.client.get(f"/api/reserved-names/{SLUG}").json()
    assert info["message"] == f"{SLUG} was deleted on {today()}"
    assert harness.client.get("/api/reserved-names/nothing").status_code == 404
    page = harness.client.get(f"/api/models/{SLUG}/overview")
    assert page.status_code == 404 and page.json()["detail"] == f"{SLUG} was deleted on {today()}"
    assert harness.client.get(f"/api/models/{SLUG}").json()["detail"] == f"{SLUG} was deleted on {today()}"


def test_asking_for_a_reserved_or_held_api_name_is_refused(harness: Harness) -> None:
    create_model(harness)
    delete(harness, SLUG)
    refused = create(harness, "Triage", api_name=SLUG)
    day = f"{now():%b} {now().day}"
    assert refused.status_code == 409
    assert refused.json()["detail"] == f"{SLUG} belonged to a deleted model (deleted {day}); pick another name"
    create(harness, "Other")
    held = create(harness, "Triage", api_name="other")
    assert held.status_code == 409 and "already uses the API name other" in held.json()["detail"]
    assert create(harness, "Triage", api_name="Not Valid").status_code == 422
    copy = harness.client.post("/api/models/other/duplicate", json={"name": "Copy", "api_name": SLUG})
    assert copy.status_code == 409 and "belonged to a deleted model" in copy.json()["detail"]


def test_duplicates_imports_and_downloads_avoid_reserved_names(harness: Harness, tmp_path: Path) -> None:
    create_model(harness)
    create(harness, "Source")
    delete(harness, SLUG)
    copy = harness.client.post("/api/models/source/duplicate", json={"name": "Support Triage"})
    assert copy.status_code == 201 and copy.json()["slug"] == f"{SLUG}-2"
    add_base(harness, "tiny")
    delete(harness, "tiny", "/api/models")
    imported = import_base(harness, tmp_path, "Tiny")
    assert imported.status_code == 202 and imported.json()["key"] == "tiny-2"
    with harness.sessions() as session:
        reserved = session.get(ReservedName, "tiny")
        assert reserved is not None and (reserved.kind, reserved.model_name) == ("base", "Tiny")


def test_v1_and_the_playground_say_when_a_name_was_deleted(harness: Harness) -> None:
    servable(harness)
    create(harness, "Other")
    headers = {"Authorization": f"Bearer {add_key(harness, ('custom', SLUG), ('custom', 'other'))['secret']}"}
    delete(harness, SLUG)
    for name in (SLUG, f"{SLUG}@0"):
        gone = harness.client.post("/v1/chat/completions", headers=headers, json=CHAT | {"model": name})
        assert gone.status_code == 404
        error = gone.json()["error"]
        assert (error["code"], error["message"]) == ("model_not_found", f"{SLUG} was deleted on {today()}")
    text = harness.client.post("/v1/completions", headers=headers, json={"model": SLUG, "prompt": "hi"})
    assert text.status_code == 404 and text.json()["error"]["message"] == f"{SLUG} was deleted on {today()}"
    unknown = harness.client.post("/v1/chat/completions", headers=headers, json=CHAT | {"model": "nope"})
    assert unknown.status_code == 404 and unknown.json()["error"]["code"] == "model_not_found"
    ask = {"model": SLUG, "messages": [{"role": "user", "content": "hi"}]}
    played = harness.client.post("/api/playground/chat/completions", json=ask)
    assert played.status_code == 404 and played.json()["detail"] == f"{SLUG} was deleted on {today()}"


def test_histories_of_a_deleted_model_and_its_successor_stay_apart(harness: Harness) -> None:
    create_model(harness)
    log(harness, model_id(harness, SLUG), SLUG)
    job(harness, SLUG)
    delete(harness, SLUG)
    create_model(harness)
    log(harness, model_id(harness, f"{SLUG}-2"), f"{SLUG}-2")
    job(harness, f"{SLUG}-2")
    assert requests(harness, model=SLUG) == [f"{SLUG}:True"]
    assert requests(harness, model=f"{SLUG}-2") == [f"{SLUG}-2:False"]
    jobs = facets(harness, "/api/jobs/facets")
    assert jobs["deleted_models"] == {SLUG: "Support Triage"} and jobs["models"] == {SLUG: 1, f"{SLUG}-2": 1}


def test_a_name_reused_before_reservations_keeps_its_old_history_apart(harness: Harness) -> None:
    create_model(harness)
    log(harness, model_id(harness, SLUG), SLUG)
    job(harness, SLUG)
    delete(harness, SLUG)
    with harness.sessions() as session:
        session.query(ReservedName).delete()
        session.commit()
    create_model(harness)
    log(harness, model_id(harness, SLUG), SLUG)
    log(harness, model_id(harness, SLUG), SLUG)
    job(harness, SLUG)
    assert requests(harness, model=SLUG) == [f"{SLUG}:False", f"{SLUG}:False"]
    assert requests(harness, model=f"deleted:{SLUG}") == [f"{SLUG}:True"]
    listed_facets = facets(harness, "/api/requests/facets")
    found = {item["value"]: (item["count"], item["deleted"]) for item in listed_facets["models"]}
    assert found == {SLUG: (2, False), f"deleted:{SLUG}": (1, True)}
    versions = {item["value"] for item in listed_facets["versions"]}
    assert versions == {f"{SLUG}@0", f"deleted:{SLUG}@0"}
    assert len(requests(harness, version=f"deleted:{SLUG}@0")) == 1
    overview = facets(harness, "/api/requests/overview")["models"]
    assert {(item["key"], item["requests"], item["deleted"]) for item in overview} == {
        (SLUG, 2, False),
        (f"deleted:{SLUG}", 1, True),
    }
    jobs = facets(harness, "/api/jobs/facets")
    assert jobs["deleted_models"] == {f"deleted:{SLUG}": "Support Triage"}
    assert jobs["models"] == {SLUG: 1, f"deleted:{SLUG}": 1}
    with harness.sessions() as session:
        live = session.scalars(select(Job.id).where(Job.model_slug == SLUG, Job.model_id.is_not(None))).all()
    listed = harness.client.get("/api/jobs", params={"model": SLUG}).json()["items"]
    assert sorted(item["id"] for item in listed) == sorted(live)


def migrate_to(url: str, revision: str) -> None:
    engine = make_engine(url, foreign_keys=False)
    config = Config()
    config.set_main_option("script_location", str(MIGRATIONS))
    config.attributes["engine"] = engine
    command.upgrade(config, revision)
    engine.dispose()


def test_the_migration_reserves_names_that_history_still_mentions(tmp_path: Path) -> None:
    url = f"sqlite:///{tmp_path / 'old.db'}"
    migrate_to(url, "0013")
    deleted = now() - timedelta(days=3)
    seen = now() - timedelta(days=5)
    sessions = sessionmaker(create_engine(url))
    with sessions() as session:
        kept = Model(slug="kept", name="Kept", preset="general", base_model="tiny")
        session.add(kept)
        session.flush()
        done = {"kind": "train", "status": "succeeded"}
        session.execute(
            insert(Job),
            [
                done | {"created_at": seen, "model_slug": "gone", "model_name": "Gone"},
                done | {"kind": "download", "created_at": seen, "base_model_key": "tiny"},
                done | {"model_id": kept.id, "model_slug": "kept", "model_name": "Kept"},
            ],
        )
        session.add_all(
            [
                RequestLog(at=seen, model="older", status=200, latency_ms=1.0, model_slug="older", model_name="Older"),
                RequestLog(at=seen, model="old-base", status=200, latency_ms=1.0, model_name="Old base"),
                RequestLog(at=seen, model="typo", status=404, latency_ms=1.0),
                AuditEvent(at=deleted, actor="ana@example.com", action="model.delete", target="gone"),
            ]
        )
        session.commit()
    migrate_to(url, "head")
    with sessions() as session:
        rows = {row.name: row for row in session.scalars(select(ReservedName))}
    assert {name: (row.kind, row.model_name, row.deleted_by) for name, row in rows.items()} == {
        "gone": ("custom", "Gone", "ana@example.com"),
        "older": ("custom", "Older", "system"),
        "old-base": ("base", "Old base", "system"),
        "tiny": ("base", "tiny", "system"),
    }
    assert rows["gone"].deleted_at == deleted and rows["older"].deleted_at == seen
