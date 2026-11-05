from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import Engine, inspect, text

from minibrain.registry.db import MIGRATIONS, make_engine
from tests.conftest import Harness, tickets_csv
from tests.test_shared_data import snapshot_hash, upload


def migration_config(engine: Engine) -> Config:
    config = Config()
    config.set_main_option("script_location", str(MIGRATIONS))
    config.attributes["engine"] = engine
    return config


def columns_of(engine: Engine, table: str) -> set[str]:
    return {column["name"] for column in inspect(engine).get_columns(table)}


def test_catalogue_migration_adds_nullable_fields_and_keeps_rows(tmp_path: Path) -> None:
    engine = make_engine(f"sqlite:///{tmp_path / 'old.db'}", foreign_keys=False)
    config = migration_config(engine)
    command.upgrade(config, "0016")
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO artifacts (id, kind, packing, name, size, created_at) "
                "VALUES ('a1', 'source', 'file', 'tickets.csv', 10, CURRENT_TIMESTAMP)"
            )
        )
        connection.execute(
            text(
                "INSERT INTO sources (name, filename, artifact_id, size, created_at) "
                "VALUES ('tickets.csv', 'tickets.csv', 'a1', 10, CURRENT_TIMESTAMP)"
            )
        )
    command.upgrade(config, "0017")
    for table in ("sources", "datasets"):
        assert {"description", "tags"} <= columns_of(engine, table)
    with engine.connect() as connection:
        assert connection.execute(text("SELECT name, description, tags FROM sources")).all() == [
            ("tickets.csv", None, None)
        ]
    command.downgrade(config, "0016")
    assert "description" not in columns_of(engine, "sources")
    assert "tags" not in columns_of(engine, "datasets")


def test_description_and_tags_round_trip_on_sources_and_datasets(harness: Harness) -> None:
    source = upload(harness)
    assert (source["kind"], source["description"], source["tags"]) == ("upload", "", [])
    changed = harness.client.patch(
        f"/api/sources/{source['id']}",
        json={"name": "Support tickets", "description": " Exported from the help desk ", "tags": ["support", " "]},
    ).json()
    assert (changed["name"], changed["filename"], changed["description"], changed["tags"]) == (
        "Support tickets",
        "tickets.csv",
        "Exported from the help desk",
        ["support"],
    )
    assert harness.client.get(f"/api/sources/{source['id']}").json()["tags"] == ["support"]
    harness.client.post("/api/datasets", json={"name": "Tickets", "source_id": source["id"]})
    edited = harness.client.patch(
        "/api/datasets/tickets", json={"description": "Category per ticket", "tags": ["triage", "en", "triage"]}
    ).json()
    assert (edited["slug"], edited["description"], edited["tags"]) == (
        "tickets",
        "Category per ticket",
        ["triage", "en"],
    )
    cleared = harness.client.patch("/api/datasets/tickets", json={"description": "", "tags": []}).json()
    assert (cleared["description"], cleared["tags"], cleared["name"]) == ("", [], "Tickets")
    assert harness.client.patch("/api/datasets/tickets", json={"name": ""}).status_code == 422


def test_dataset_created_with_the_picked_columns(harness: Harness) -> None:
    source = upload(harness)
    body = {"name": "Reversed", "source_id": source["id"], "input_column": "category", "label_column": "text"}
    created = harness.client.post("/api/datasets", json=body).json()
    assert (created["mapping"]["input_column"], created["mapping"]["label_column"]) == ("category", "text")
    single = "SELECT text AS input, category AS label FROM source WHERE category = 'bug'"
    refused = harness.client.post("/api/datasets", json={"name": "Bugs", "source_id": source["id"], "sql": single})
    assert refused.status_code == 409 and refused.json()["detail"].startswith("Only one label")
    sql = "SELECT text AS input, category AS label FROM source WHERE category IN ('bug', 'billing')"
    by_sql = harness.client.post("/api/datasets", json={"name": "Bugs", "source_id": source["id"], "sql": sql}).json()
    assert (by_sql["mapping"]["sql"], by_sql["mapping"]["input_column"]) == (sql, None)
    assert (by_sql["snapshot"]["number"], by_sql["snapshot"]["rows"]) == (1, 100)
    bad = {"name": "Broken", "source_id": source["id"], "input_column": "nope", "label_column": "text"}
    assert harness.client.post("/api/datasets", json=bad).status_code == 422
    assert [dataset["slug"] for dataset in harness.client.get("/api/datasets").json()] == ["bugs", "reversed"]


def test_column_stats_come_from_a_bounded_sample(harness: Harness) -> None:
    rows = tickets_csv(30) + b",bug\n"
    source = harness.client.post("/api/sources", files={"file": ("tickets.csv", rows, "text/csv")}).json()
    stats = harness.client.get(f"/api/sources/{source['id']}/stats").json()
    assert (stats["rows"], stats["sampled"]) == (31, 31)
    by_name = {column["name"]: column for column in stats["columns"]}
    assert by_name["text"]["nulls"] == 1
    assert by_name["category"]["type"] == "VARCHAR"
    assert by_name["category"]["distinct"] == 4
    assert (by_name["category"]["min"], by_name["category"]["max"]) == ("account", "feature")
    queried = harness.client.post(
        f"/api/sources/{source['id']}/query", json={"sql": "SELECT category, count(*) AS n FROM source GROUP BY 1"}
    ).json()
    assert queried["columns"] == ["category", "n"] and len(queried["rows"]) == 4


def test_preview_counts_rows_per_label(harness: Harness) -> None:
    source = upload(harness)
    harness.client.post("/api/datasets", json={"name": "Tickets", "source_id": source["id"]})
    counts = harness.client.get("/api/datasets/tickets/preview").json()["label_counts"]
    assert counts == [{"label": label, "rows": 50} for label in ("account", "billing", "bug", "feature")]


def test_splits_come_from_the_latest_version(harness: Harness) -> None:
    source = upload(harness)
    harness.client.post("/api/datasets", json={"name": "Tickets", "source_id": source["id"]})
    harness.client.post("/api/minibrains", json={"labels": ["billing", "bug"], "name": "Triage"})
    harness.client.put("/api/minibrains/triage/dataset", json={"dataset": "tickets"})
    splits = harness.client.get("/api/datasets/tickets").json()["splits"]
    assert snapshot_hash(harness, "triage") == harness.client.get("/api/datasets/tickets").json()["snapshot"]["hash"]
    assert sum(splits.values()) == 200
    harness.client.patch("/api/datasets/tickets", json={"description": "still the same rows"})
    assert harness.client.get("/api/datasets/tickets").json()["splits"] == splits
    harness.client.put("/api/datasets/tickets/mapping", json={"input_column": "category", "label_column": "text"})
    assert harness.client.get("/api/datasets/tickets").json()["splits"] is None


def test_samples_are_listed_and_can_be_added_again_after_a_delete(harness: Harness) -> None:
    samples = harness.client.get("/api/samples").json()
    assert [sample["file"] for sample in samples] == ["travel_intents.jsonl", "banking77.csv", "clinc150.parquet"]
    first = harness.client.post("/api/samples/banking77.csv").json()
    assert first["filename"] == "banking77.csv"
    assert first["tags"] == ["minibrain:sample"]
    assert first["rows"] == 13_083
    assert harness.client.delete(f"/api/sources/{first['id']}").status_code == 204
    again = harness.client.post("/api/samples/banking77.csv").json()
    assert again["id"] > first["id"]
    assert again["rows"] == 13_083


def test_unknown_sample_is_not_found(harness: Harness) -> None:
    assert harness.client.post("/api/samples/other.csv").status_code == 404


def test_a_new_file_never_reads_a_deleted_file_staging(harness: Harness) -> None:
    first = upload(harness)
    assert harness.client.delete(f"/api/sources/{first['id']}").status_code == 204
    second = harness.client.post("/api/samples/travel_intents.jsonl").json()
    assert second["rows"] == 750
    assert {column["name"] for column in second["columns"]} != {column["name"] for column in first["columns"]}


def test_tags_keep_key_value_form_and_refuse_the_system_prefix(harness: Harness) -> None:
    source = upload(harness)
    changed = harness.client.patch(
        f"/api/sources/{source['id']}", json={"tags": ["Team : fraud", "eu", "team:fraud", " eu "]}
    )
    assert changed.status_code == 200, changed.text
    assert changed.json()["tags"] == ["team:fraud", "eu"]
    refused = harness.client.patch(f"/api/sources/{source['id']}", json={"tags": ["minibrain:sample"]})
    assert refused.status_code == 422
    assert harness.client.patch(f"/api/sources/{source['id']}", json={"tags": ["team:"]}).status_code == 422


def test_editing_tags_keeps_the_system_tags(harness: Harness) -> None:
    sample = harness.client.post("/api/samples/travel_intents.jsonl").json()
    assert sample["tags"] == ["minibrain:sample"]
    edited = harness.client.patch(f"/api/sources/{sample['id']}", json={"tags": ["demo"]}).json()
    assert edited["tags"] == ["minibrain:sample", "demo"]


def test_a_dataset_can_stack_sources_that_share_columns(harness: Harness) -> None:
    sources = [
        harness.client.post("/api/sources", files={"file": (name, tickets_csv(rows), "text/csv")}).json()
        for name, rows in (("march.csv", 200), ("april.csv", 150))
    ]
    sql = "\nUNION ALL\n".join(
        f'SELECT "text" AS input, "category" AS label FROM "{source["table"]}"' for source in sources
    )
    response = harness.client.post("/api/datasets", json={"name": "Tickets", "sql": sql})
    assert response.status_code == 201, response.text
    dataset = response.json()
    assert sorted(source["id"] for source in dataset["sources"]) == sorted(source["id"] for source in sources)
    assert dataset["rows"] == 350
