from pathlib import Path

from alembic import command
from sqlalchemy import text

from minibrain.registry.db import make_engine
from tests.conftest import Harness, tickets_csv
from tests.test_data_catalogue import migration_config

LABELS_CSV = b"label,team\nbilling,finance\nbug,engineering\naccount,support\nfeature,product\n"


def upload(harness: Harness, name: str, data: bytes) -> dict:
    response = harness.client.post("/api/sources", files={"file": (name, data, "text/csv")})
    assert response.status_code == 201, response.text
    return response.json()


def test_sources_get_stable_unique_table_names(harness: Harness) -> None:
    first = upload(harness, "Support tickets.csv", tickets_csv())
    second = upload(harness, "Support tickets.csv", tickets_csv(10))
    assert (first["table"], second["table"]) == ("support_tickets", "support_tickets_2")
    renamed = harness.client.patch(f"/api/sources/{first['id']}", json={"name": "Help desk"}).json()
    assert (renamed["name"], renamed["table"]) == ("Help desk", "support_tickets")


def test_a_sql_dataset_joins_several_sources_by_table_name(harness: Harness) -> None:
    tickets = upload(harness, "tickets.csv", tickets_csv())
    teams = upload(harness, "teams.csv", LABELS_CSV)
    sql = (
        "SELECT t.text AS input, teams.team AS label, t.category AS old_label "
        "FROM tickets t JOIN teams ON teams.label = t.category WHERE teams.team <> 'product'"
    )
    created = harness.client.post("/api/datasets", json={"name": "Routing", "sql": sql})
    assert created.status_code == 201, created.text
    dataset = created.json()
    assert dataset["mode"] == "sql"
    assert dataset["source_id"] is None
    assert [source["table"] for source in dataset["sources"]] == ["teams", "tickets"]
    assert dataset["rows"] == 150
    assert [column["name"] for column in dataset["columns"]] == ["input", "label", "old_label"]
    preview = harness.client.get("/api/datasets/routing/preview").json()
    assert preview["labels"] == ["engineering", "finance", "support"]
    assert preview["quality"]["rows"] == 150
    for source in (tickets, teams):
        assert harness.client.get(f"/api/sources/{source['id']}").json()["datasets"] == ["routing"]
    blocked = harness.client.delete(f"/api/sources/{teams['id']}")
    assert blocked.status_code == 409 and "Routing" in blocked.json()["detail"]


def test_column_mode_generates_the_select_over_the_picked_source(harness: Harness) -> None:
    tickets = upload(harness, "tickets.csv", tickets_csv())
    other = upload(harness, "other tickets.csv", tickets_csv(40))
    harness.client.post("/api/datasets", json={"name": "Tickets", "source_id": tickets["id"]})
    mapped = harness.client.put(
        "/api/datasets/tickets/mapping",
        json={"source_id": other["id"], "input_column": "text", "label_column": "category"},
    ).json()
    assert mapped["mode"] == "columns"
    assert mapped["source_id"] == other["id"]
    assert mapped["rows"] == 40
    assert mapped["mapping"]["sql"].endswith("FROM other_tickets")
    assert harness.client.get(f"/api/sources/{tickets['id']}").json()["datasets"] == []


def test_queries_must_be_one_select_over_known_sources(harness: Harness) -> None:
    upload(harness, "tickets.csv", tickets_csv())
    for sql, message in (
        ("SELECT 1 AS input, 2 AS label", "reads no source"),
        ("SELECT text AS input, category AS label FROM tickets; SELECT 1", "one SELECT"),
        ("COPY (SELECT * FROM tickets) TO '/tmp/out.csv'", "single SELECT"),
        ("SELECT text, category FROM tickets", "input column and a label column"),
    ):
        response = harness.client.post("/api/datasets", json={"name": "Broken", "sql": sql})
        assert response.status_code == 422, response.text
        assert message in response.json()["detail"]
    ran = harness.client.post("/api/query", json={"sql": "SELECT category, count(*) AS n FROM tickets GROUP BY 1"})
    assert ran.status_code == 200 and len(ran.json()["rows"]) == 4


def test_a_single_source_dataset_can_say_from_source(harness: Harness) -> None:
    tickets = upload(harness, "tickets.csv", tickets_csv())
    harness.client.post("/api/datasets", json={"name": "Tickets", "source_id": tickets["id"]})
    mapped = harness.client.put(
        "/api/datasets/tickets/mapping", json={"sql": "SELECT text AS input, category AS label FROM source"}
    )
    assert mapped.status_code == 200, mapped.text
    assert mapped.json()["rows"] == 200
    queried = harness.client.post("/api/datasets/tickets/query", json={"sql": "SELECT count(*) AS n FROM source"})
    assert queried.json()["rows"] == [["200"]]


def test_migration_names_tables_and_links_datasets_to_sources(tmp_path: Path) -> None:
    engine = make_engine(f"sqlite:///{tmp_path / 'old.db'}", foreign_keys=False)
    config = migration_config(engine)
    command.upgrade(config, "0017")
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO artifacts (id, kind, packing, name, size, created_at) "
                "VALUES ('a1', 'source', 'file', 'tickets.csv', 10, CURRENT_TIMESTAMP)"
            )
        )
        for name in ("tickets.csv", "Tickets", "2025.csv"):
            connection.execute(
                text(
                    "INSERT INTO sources (name, filename, artifact_id, size, created_at) "
                    "VALUES (:name, 'tickets.csv', 'a1', 10, CURRENT_TIMESTAMP)"
                ),
                {"name": name},
            )
        connection.execute(
            text(
                "INSERT INTO datasets (slug, name, source_id, created_at, updated_at) "
                "VALUES ('tickets', 'Tickets', 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            )
        )
    command.upgrade(config, "0018")
    with engine.connect() as connection:
        assert connection.execute(text("SELECT table_name FROM sources ORDER BY id")).scalars().all() == [
            "tickets",
            "tickets_2",
            "t_2025",
        ]
        assert connection.execute(text("SELECT dataset_id, source_id FROM dataset_sources")).all() == [(1, 2)]
    command.downgrade(config, "0017")
    with engine.connect() as connection:
        assert connection.execute(text("SELECT source_id FROM datasets")).scalars().all() == [2]
