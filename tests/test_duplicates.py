from dataclasses import dataclass
from pathlib import Path
from typing import Any

import duckdb
import pytest
from sqlalchemy import func, select

from minibrain.data import remote
from minibrain.data.names import free_name
from minibrain.registry.models import Artifact, Source
from tests.conftest import Harness, tickets_csv
from tests.test_folders import allow
from tests.test_remote_sources import FileDatabase, database_connection


def send(harness: Harness, name: str, data: bytes, name_taken: str | None = None) -> Any:
    params = {"name_taken": name_taken} if name_taken else {}
    return harness.client.post("/api/sources", params=params, files={"file": (name, data, "text/csv")})


def sources(harness: Harness) -> dict[str, str]:
    return {source["name"]: source["table"] for source in harness.client.get("/api/sources").json()}


def artifact_of(harness: Harness, source_id: int) -> str:
    with harness.sessions() as session:
        found = session.get(Source, source_id)
        assert found is not None and found.artifact_id is not None
        return found.artifact_id


def artifacts(harness: Harness) -> int:
    with harness.sessions() as session:
        return session.scalar(select(func.count()).select_from(Artifact)) or 0


def test_numbered_names_keep_the_file_type_and_ignore_case() -> None:
    assert free_name("tickets.csv", []) == "tickets.csv"
    assert free_name("tickets.csv", ["Tickets.CSV"]) == "tickets (2).csv"
    assert free_name("tickets.csv", ["tickets.csv", "tickets (2).csv"]) == "tickets (3).csv"
    assert free_name("tickets (2).csv", ["tickets (2).csv"]) == "tickets (3).csv"
    assert free_name("Routing", ["routing", "Routing (2)"]) == "Routing (3)"
    assert free_name("Report 2.0", ["Report 2.0"]) == "Report 2.0 (2)"
    assert free_name(".csv", [".csv"]) == ".csv (2)"


def test_the_same_content_is_one_source_whatever_its_name(harness: Harness) -> None:
    first = send(harness, "tickets.csv", tickets_csv())
    assert first.status_code == 201 and first.json()["outcome"] == "created"
    for name in ("tickets.csv", "renamed copy.csv"):
        again = send(harness, name, tickets_csv())
        assert again.status_code == 200, again.text
        assert (again.json()["outcome"], again.json()["id"], again.json()["name"]) == (
            "existing",
            first.json()["id"],
            "tickets.csv",
        )
    assert sources(harness) == {"tickets.csv": "tickets"}
    assert artifacts(harness) == 1


def test_a_taken_name_with_new_content_keeps_both_by_default(harness: Harness) -> None:
    send(harness, "tickets.csv", tickets_csv())
    second = send(harness, "Tickets.csv", tickets_csv(40))
    assert second.status_code == 201, second.text
    assert (second.json()["outcome"], second.json()["name"], second.json()["filename"]) == (
        "created",
        "Tickets (2).csv",
        "Tickets.csv",
    )
    third = send(harness, "tickets.csv", tickets_csv(50), "keep_both")
    assert third.json()["name"] == "tickets (3).csv"
    assert sources(harness) == {
        "tickets.csv": "tickets",
        "Tickets (2).csv": "tickets_2",
        "tickets (3).csv": "tickets_3",
    }


def test_fail_reports_the_taken_name_and_adds_nothing(harness: Harness) -> None:
    first = send(harness, "tickets.csv", tickets_csv()).json()
    refused = send(harness, "tickets.csv", tickets_csv(40), "fail")
    assert refused.status_code == 409
    assert refused.json() == {
        "detail": "There is already a source called tickets.csv",
        "name": "tickets.csv",
        "suggestion": "tickets (2).csv",
        "taken": first["id"],
    }
    assert sources(harness) == {"tickets.csv": "tickets"}
    assert artifacts(harness) == 1
    same = send(harness, "tickets.csv", tickets_csv(), "fail")
    assert same.status_code == 200 and same.json()["outcome"] == "existing"
    assert send(harness, "tickets.csv", tickets_csv(40), "sometimes").status_code == 422


def test_replace_changes_the_content_so_datasets_reading_it_need_an_update(harness: Harness) -> None:
    first = send(harness, "tickets.csv", tickets_csv()).json()
    old = artifact_of(harness, first["id"])
    created = harness.client.post("/api/datasets", json={"name": "Tickets", "source_id": first["id"]})
    assert created.status_code == 201, created.text
    assert created.json()["changed"]["data"] is False
    assert created.json()["snapshot"]["number"] == 1
    replaced = send(harness, "TICKETS.csv", tickets_csv(120), "replace")
    assert replaced.status_code == 200, replaced.text
    body = replaced.json()
    assert (body["outcome"], body["id"], body["name"], body["filename"], body["table"], body["rows"]) == (
        "replaced",
        first["id"],
        "tickets.csv",
        "TICKETS.csv",
        "tickets",
        120,
    )
    assert body["datasets"] == ["tickets"]
    assert not harness.app.state.store.has(old)
    assert artifacts(harness) == 2
    dataset = harness.client.get("/api/datasets/tickets").json()
    assert dataset["changed"]["data"] is True and dataset["rows"] == 120
    update = harness.client.post("/api/datasets/tickets/snapshots")
    assert update.status_code == 201, update.text
    assert (update.json()["number"], update.json()["rows"]) == (2, 120)
    same = send(harness, "tickets.csv", tickets_csv(120), "replace")
    assert same.status_code == 200 and same.json()["outcome"] == "existing"
    unchanged = send(harness, "other.csv", tickets_csv(120), "replace")
    assert (unchanged.json()["outcome"], unchanged.json()["name"]) == ("existing", "tickets.csv")


def test_replace_without_a_taken_name_adds_the_file(harness: Harness) -> None:
    added = send(harness, "tickets.csv", tickets_csv(), "replace")
    assert added.status_code == 201 and added.json()["outcome"] == "created"


def test_deleting_an_upload_removes_its_stored_file(harness: Harness) -> None:
    source = send(harness, "tickets.csv", tickets_csv()).json()
    stored = artifact_of(harness, source["id"])
    assert harness.app.state.store.has(stored)
    assert harness.client.delete(f"/api/sources/{source['id']}").status_code == 204
    assert not harness.app.state.store.has(stored)
    assert artifacts(harness) == 0
    again = send(harness, "tickets.csv", tickets_csv())
    assert again.status_code == 201 and again.json()["outcome"] == "created"


def test_samples_are_added_once(harness: Harness) -> None:
    first = harness.client.post("/api/samples/travel_intents.jsonl")
    assert first.status_code == 201 and first.json()["outcome"] == "created"
    again = harness.client.post("/api/samples/travel_intents.jsonl")
    assert again.status_code == 200
    assert (again.json()["outcome"], again.json()["id"]) == ("existing", first.json()["id"])
    assert len(harness.client.get("/api/sources").json()) == 1


def test_source_names_are_unique_when_typed_and_numbered_when_derived(harness: Harness, tmp_path: Path) -> None:
    first = send(harness, "tickets.csv", tickets_csv()).json()
    other = send(harness, "other.csv", tickets_csv(40)).json()
    clash = harness.client.patch(f"/api/sources/{other['id']}", json={"name": "TICKETS.csv"})
    assert clash.status_code == 409
    assert clash.json()["detail"] == "There is already a source called tickets.csv"
    assert (clash.json()["taken"], clash.json()["suggestion"]) == (first["id"], "TICKETS (2).csv")
    own = harness.client.patch(f"/api/sources/{first['id']}", json={"name": "Tickets.CSV"})
    assert own.status_code == 200 and own.json()["name"] == "Tickets.CSV"
    assert harness.client.patch(f"/api/sources/{first['id']}", json={"name": "   "}).status_code == 422
    exports = tmp_path / "tickets"
    exports.mkdir()
    (exports / "a.csv").write_bytes(tickets_csv(10))
    allow(harness, tmp_path)
    typed = harness.client.post("/api/sources/folders", json={"path": str(exports), "name": "other.csv"})
    assert typed.status_code == 409 and typed.json()["detail"] == "There is already a source called other.csv"
    folder = harness.client.post("/api/sources/folders", json={"path": str(exports), "name": "Tickets"})
    assert folder.status_code == 201 and folder.json()["name"] == "Tickets"
    derived = tmp_path / "Other" / "tickets"
    derived.mkdir(parents=True)
    (derived / "b.csv").write_bytes(tickets_csv(12))
    numbered = harness.client.post("/api/sources/folders", json={"path": str(derived)})
    assert numbered.status_code == 201 and numbered.json()["name"] == "tickets (2)"
    renamed = harness.client.patch(f"/api/sources/{folder.json()['id']}", json={"name": "folder_tickets.csv"})
    assert renamed.status_code == 200
    replace = send(harness, "folder_tickets.csv", tickets_csv(70), "replace")
    assert replace.status_code == 409
    assert (
        replace.json()["detail"]
        == "folder_tickets.csv is not an uploaded file, so a file cannot replace it; keep both instead"
    )


def test_a_folder_added_twice_is_one_source(harness: Harness, tmp_path: Path) -> None:
    exports = tmp_path / "exports"
    exports.mkdir()
    (exports / "a.csv").write_bytes(tickets_csv(10))
    allow(harness, tmp_path)
    first = harness.client.post("/api/sources/folders", json={"path": str(exports)})
    assert first.status_code == 201, first.text
    same = harness.client.post("/api/sources/folders", json={"path": f"{exports}/", "name": "Copy", "format": ".csv"})
    assert same.status_code == 200, same.text
    assert (same.json()["outcome"], same.json()["id"], same.json()["name"]) == (
        "existing",
        first.json()["id"],
        "exports",
    )
    as_json = harness.client.post("/api/sources/folders", json={"path": str(exports), "format": ".json"})
    assert as_json.status_code != 200
    assert len(harness.client.get("/api/sources").json()) == 1


@dataclass(frozen=True)
class QueryDatabase(FileDatabase):
    def open(self, connection: duckdb.DuckDBPyConnection, alias: str) -> str:
        table = super().open(connection, alias)
        return self.query.replace("FROM tickets", f"FROM {alias}.main.tickets") if self.query else table


@pytest.fixture
def shop(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "shop.duckdb"
    with duckdb.connect(str(path)) as connection:
        connection.execute("CREATE TABLE tickets AS SELECT range AS id, 'ticket ' || range AS body FROM range(20)")
    monkeypatch.setattr(remote, "DatabaseReader", QueryDatabase)
    return path


def test_a_database_table_or_query_added_twice_is_one_source(harness: Harness, shop: Path) -> None:
    connection = database_connection(harness, shop)
    table = {"connection_id": connection["id"], "table": "tickets"}
    first = harness.client.post("/api/sources/database", json=table)
    assert first.status_code == 201, first.text
    again = harness.client.post("/api/sources/database", json=table | {"name": "Copy", "change_column": "id"})
    assert again.status_code == 200
    assert (again.json()["outcome"], again.json()["id"]) == ("existing", first.json()["id"])
    query = {"connection_id": connection["id"], "query": "SELECT * FROM tickets WHERE id < 5"}
    by_query = harness.client.post("/api/sources/database", json=query)
    assert by_query.status_code == 201, by_query.text
    assert by_query.json()["name"] == "Shop"
    assert harness.client.post("/api/sources/database", json=query).json()["outcome"] == "existing"
    other = harness.client.post("/api/sources/database", json=query | {"query": "SELECT * FROM tickets"})
    assert other.status_code == 201 and other.json()["name"] == "Shop (2)"


def test_dataset_names_are_unique_within_their_folder(harness: Harness) -> None:
    source = send(harness, "tickets.csv", tickets_csv()).json()

    def create(name: str, folder_id: int | None = None) -> Any:
        body = {"name": name, "source_id": source["id"], "folder_id": folder_id}
        return harness.client.post("/api/datasets", json=body)

    assert create("Routing").status_code == 201
    clash = create("  routing ")
    assert clash.status_code == 409
    assert clash.json() == {
        "detail": "Datasets already has a dataset called Routing",
        "name": "Routing",
        "suggestion": "routing (2)",
        "taken": "routing",
    }
    assert create("   ").status_code == 422
    support = harness.client.post("/api/dataset-folders", json={"name": "Support"}).json()
    inside = create("Routing", support["id"])
    assert inside.status_code == 201 and inside.json()["slug"] == "routing-2"
    nested = create("ROUTING", support["id"])
    assert nested.status_code == 409 and nested.json()["detail"] == "Support already has a dataset called Routing"
    assert nested.json()["taken"] == "routing-2"
    assert create("Triage").status_code == 201
    renamed = harness.client.patch("/api/datasets/triage", json={"name": "routing"})
    assert renamed.status_code == 409 and renamed.json()["suggestion"] == "routing (2)"
    own = harness.client.patch("/api/datasets/routing", json={"name": "ROUTING"})
    assert own.status_code == 200 and own.json()["name"] == "ROUTING"
    moved = harness.client.put("/api/datasets/routing/folder", json={"folder_id": support["id"]})
    assert moved.status_code == 409 and moved.json()["detail"] == "Support already has a dataset called Routing"
    assert harness.client.put("/api/datasets/triage/folder", json={"folder_id": support["id"]}).status_code == 200
    assert harness.client.delete(f"/api/dataset-folders/{support['id']}").status_code == 204
    names = {
        dataset["slug"]: (dataset["name"], dataset["folder_id"])
        for dataset in harness.client.get("/api/datasets").json()
    }
    assert names == {"routing": ("ROUTING", None), "routing-2": ("Routing (2)", None), "triage": ("Triage", None)}
    events = harness.client.get("/api/audit", params={"action": "dataset_folder.delete"}).json()["events"]
    assert events[0]["detail"]["renamed"] == ["Routing → Routing (2)"]


def test_folder_names_report_the_taken_name_and_a_free_one(harness: Harness) -> None:
    first = harness.client.post("/api/dataset-folders", json={"name": "Support"}).json()
    clash = harness.client.post("/api/dataset-folders", json={"name": "support"})
    assert clash.status_code == 409
    assert clash.json() == {
        "detail": "Datasets already has a folder called Support",
        "name": "Support",
        "suggestion": "support (2)",
        "taken": first["id"],
    }
