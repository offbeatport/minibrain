import os
import shutil
from pathlib import Path

import duckdb
import pyarrow as pa
import pytest
from deltalake import DeltaTable, write_deltalake
from sqlalchemy import select

from minibrain.data import delta, extensions
from minibrain.data.sources import SourceError, Table, run_query, statement_tables
from minibrain.registry.models import Snapshot
from tests.conftest import LABELS, Harness

EXTENSIONS = os.environ.get("MINIBRAIN_TEST_DUCKDB_EXTENSIONS")


def tickets(start: int, rows: int) -> pa.Table:
    numbers = range(start, start + rows)
    return pa.table(
        {
            "text": [f"ticket {number} about {LABELS[number % 4]}" for number in numbers],
            "category": [LABELS[number % 4] for number in numbers],
        }
    )


def write(root: Path, start: int, rows: int) -> None:
    write_deltalake(str(root), tickets(start, rows), mode="append")


def allow(harness: Harness, *roots: Path) -> None:
    body = {"value": [str(root) for root in roots]}
    assert harness.client.put("/api/policies/data_folders", json=body).status_code == 200


@pytest.fixture
def lake(tmp_path: Path) -> Path:
    root = tmp_path / "lake"
    write(root / "tickets", 0, 150)
    return root


def test_the_version_comes_from_the_newest_commit_in_the_log(lake: Path) -> None:
    table = lake / "tickets"
    first = delta.delta_state(table)
    assert (first.reader.version, first.detail) == (0, "Version 0; changes are tracked by the table version")
    assert first.fingerprint.startswith("v0-") and first.modified_at is not None
    assert first.reader.directories == (f"{table}/",)
    with duckdb.connect() as connection:
        assert first.reader.open(connection, "remote_0") == f"SELECT * FROM delta_scan('{table}', version = 0)"
    write(table, 150, 60)
    second = delta.delta_state(table)
    assert second.reader.version == 1 and second.fingerprint.startswith("v1-")
    DeltaTable(str(table)).create_checkpoint()
    assert delta.delta_state(table).fingerprint == second.fingerprint
    (table / "_delta_log" / "00000000000000000000.json").unlink()
    assert delta.delta_state(table).fingerprint == second.fingerprint
    (table / "_delta_log" / "00000000000000000001.json").unlink()
    assert delta.delta_state(table).reader.version == 1


def test_a_table_written_again_from_scratch_counts_as_changed(lake: Path) -> None:
    table = lake / "tickets"
    before = delta.delta_state(table)
    shutil.rmtree(table)
    write(table, 0, 150)
    after = delta.delta_state(table)
    assert after.reader.version == 0 and after.fingerprint != before.fingerprint


def test_folders_without_a_log_are_refused(tmp_path: Path) -> None:
    plain = tmp_path / "plain"
    plain.mkdir()
    with pytest.raises(SourceError, match="no _delta_log folder"):
        delta.delta_state(plain)
    (plain / "_delta_log").mkdir()
    with pytest.raises(SourceError, match="has no commits"):
        delta.delta_state(plain)
    linked = tmp_path / "linked"
    linked.mkdir()
    os.symlink(plain / "_delta_log", linked / "_delta_log")
    with pytest.raises(SourceError, match="symbolic link"):
        delta.delta_state(linked)


def test_delta_tables_are_read_only_from_folders_on_this_server(harness: Harness, lake: Path) -> None:
    for path in ("s3://lake/tickets", "https://lake.internal/tickets", "az://lake/tickets", "gs://lake/tickets"):
        response = harness.client.post("/api/sources/delta", json={"path": path})
        assert response.status_code == 422
        assert "not FIPS-ready" in response.json()["detail"] and "rustls" in response.json()["detail"]
    table = str(lake / "tickets")
    refused = harness.client.post("/api/sources/delta", json={"path": table})
    assert refused.status_code == 422 and "no folders are allowed" in refused.json()["detail"]
    allow(harness, lake / "elsewhere")
    outside = harness.client.post("/api/sources/delta", json={"path": table})
    assert outside.status_code == 422 and "outside the folders" in outside.json()["detail"]
    allow(harness, lake)
    plain = harness.client.post("/api/sources/delta", json={"path": str(lake)})
    assert plain.status_code == 422 and "no _delta_log folder" in plain.json()["detail"]
    as_folder = harness.client.post("/api/sources/folders", json={"path": table})
    assert as_folder.status_code == 422 and "Lakehouse table" in as_folder.json()["detail"]


def test_a_missing_delta_extension_is_named_and_never_downloaded(harness: Harness, lake: Path) -> None:
    if EXTENSIONS:
        pytest.skip("the DuckDB delta extension is installed for this run")
    allow(harness, lake)
    response = harness.client.post("/api/sources/delta", json={"path": f"file://{lake / 'tickets'}"})
    assert response.status_code == 422
    assert "delta extension is not installed" in response.json()["detail"]
    assert "minibrain extensions install" in response.json()["detail"]
    listed = harness.client.get("/api/extensions").json()["extensions"]
    assert {item["name"]: item["purpose"] for item in listed}["delta"] == "Delta Lake sources"
    assert harness.client.get("/api/sources").json() == []


def test_dataset_sql_cannot_call_the_delta_scanner() -> None:
    with pytest.raises(SourceError, match="delta_scan cannot be used"):
        statement_tables("SELECT * FROM delta_scan('/srv/lake/tickets')")


@pytest.mark.skipif(not EXTENSIONS, reason="needs a folder of DuckDB extensions")
def test_delta_tables_read_in_place_and_snapshot_their_version(
    harness: Harness, lake: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(extensions.DIRECTORY_ENV, str(EXTENSIONS))
    table = lake / "tickets"
    allow(harness, lake)
    response = harness.client.post("/api/sources/delta", json={"path": str(table), "name": "Lake tickets"})
    assert response.status_code == 201, response.text
    source = response.json()
    assert (source["kind"], source["table"], source["rows"], source["path"]) == (
        "delta",
        "lake_tickets",
        150,
        str(table),
    )
    assert [column["name"] for column in source["columns"]] == ["text", "category"]
    assert source["fingerprint"].startswith("v0-") and source["fingerprint_detail"].startswith("Version 0")
    rows = harness.client.get(f"/api/sources/{source['id']}/rows").json()
    assert rows["columns"] == ["text", "category"] and len(rows["rows"]) > 0
    stats = harness.client.get(f"/api/sources/{source['id']}/stats").json()
    assert stats["rows"] == 150
    created = harness.client.post("/api/datasets", json={"name": "Lake", "source_id": source["id"]})
    assert created.status_code == 201, created.text
    first = harness.client.post("/api/datasets/lake/snapshots")
    assert first.status_code == 201, first.text
    assert first.json()["rows"] == 150 and first.json()["checks"]
    write(table, 150, 60)
    summary = harness.client.get("/api/datasets/lake").json()
    assert summary["changed"] == {"data": True, "query": False, "dataset": False}
    second = harness.client.post("/api/datasets/lake/snapshots").json()
    assert second["rows"] == 210
    with harness.sessions() as session:
        prints = [found.fingerprints or {} for found in session.scalars(select(Snapshot).order_by(Snapshot.id))]
    assert prints[0]["lake_tickets"].startswith("v0-") and prints[1]["lake_tickets"].startswith("v1-")
    pinned = Table(name="pinned", remote=delta.DeltaReader(root=str(table), version=0))
    assert run_query([pinned], "SELECT count(*) FROM pinned", None).rows == [[150]]
    escape = harness.client.post("/api/query", json={"sql": "SELECT * FROM read_parquet('/etc/hosts')"})
    assert escape.status_code == 422
