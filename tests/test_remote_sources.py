import json
import os
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import duckdb
import pytest

from minibrain.connections import s3 as connection_s3
from minibrain.connections.spec import ConnectionConfig
from minibrain.connections.store import Resolved
from minibrain.data import extensions, remote
from minibrain.data.sources import READERS, SourceError, statement_tables
from minibrain.registry.models import Job
from tests.conftest import Harness
from tests.fake_s3 import ACCESS_KEY, SECRET_KEY, FakeS3, fake_s3
from tests.test_models import FILES

PASSWORD = "db-password-never-shown-42"


@pytest.fixture
def bucket() -> Iterator[FakeS3]:
    with fake_s3() as found:
        found.bucket("data")
        yield found


def parquet(tmp_path: Path, rows: int = 120, name: str = "part.parquet") -> bytes:
    target = tmp_path / name
    with duckdb.connect() as connection:
        connection.execute(
            "COPY (SELECT 'ticket ' || range AS text, (['billing', 'bug', 'account', 'feature'])[range % 4 + 1] "
            f"AS category FROM range({rows})) TO '{target}' (FORMAT parquet)"
        )
    return target.read_bytes()


def s3_connection(harness: Harness, fake: FakeS3, **extra: Any) -> dict:
    body = {
        "name": "Lake",
        "kind": "s3",
        "endpoint": fake.endpoint,
        "access_key": ACCESS_KEY,
        "secret": SECRET_KEY,
        "path_style": True,
    }
    response = harness.client.post("/api/connections", json=body | extra)
    assert response.status_code == 201, response.text
    return response.json()


def resolved(fake: FakeS3, bucket_name: str = "") -> Resolved:
    config = ConnectionConfig(kind="s3", endpoint=fake.endpoint, access_key=ACCESS_KEY, bucket=bucket_name)
    return Resolved(id=1, name="Lake", config=config, secret=SECRET_KEY)


def test_dataset_sql_names_sources_only_by_table() -> None:
    assert statement_tables("SELECT * FROM tickets JOIN main.labels USING (id)") == {"tickets", "labels"}
    with pytest.raises(SourceError, match="table name alone"):
        statement_tables("SELECT * FROM remote_staged_0.public.users")
    with pytest.raises(SourceError, match="table name alone"):
        statement_tables("SELECT * FROM tickets WHERE id IN (SELECT id FROM other.secret)")
    for call in ("postgres_query('pg', 'SELECT 1')", "mysql_scan('a', 'b', 'c')", "query_table('x')", "query('x')"):
        with pytest.raises(SourceError, match="cannot be used"):
            statement_tables(f"SELECT * FROM {call}")
    assert statement_tables("SELECT * FROM tickets, range(3)") == {"tickets"}


def test_s3_paths_are_parsed_and_fingerprinted_by_etag_and_size(bucket: FakeS3, tmp_path: Path) -> None:
    data = parquet(tmp_path)
    bucket.put("data", "exports/2025/jan.parquet", data)
    bucket.put("data", "exports/feb.parquet", data)
    bucket.put("data", "exports/_SUCCESS", b"")
    bucket.put("data", "exports/notes.csv", b"a,b\n1,2\n")
    connection = resolved(bucket)
    state = remote.s3_state(connection, "s3://data/exports/", None)
    assert (state.format, state.files, state.size) == (".parquet", 2, 2 * len(data))
    assert state.reader.files == ("s3://data/exports/2025/jan.parquet", "s3://data/exports/feb.parquet")
    globbed = remote.s3_state(connection, "s3://data/exports/*.csv", None)
    assert (globbed.format, globbed.files) == (".csv", 1)
    assert remote.s3_state(connection, "s3://data/exports/", None).fingerprint == state.fingerprint
    bucket.put("data", "exports/feb.parquet", parquet(tmp_path, 80))
    assert remote.s3_state(connection, "s3://data/exports/", None).fingerprint != state.fingerprint
    with pytest.raises(SourceError, match="starts with s3://"):
        remote.s3_state(connection, "data/exports", None)
    with pytest.raises(SourceError, match="for the bucket models"):
        remote.s3_state(resolved(bucket, "models"), "s3://data/exports/", None)
    with pytest.raises(SourceError, match=r"no \.json files"):
        remote.s3_state(connection, "s3://data/exports/*.json", None)


class Recorder:
    def __init__(self) -> None:
        self.statements: list[str] = []

    def execute(self, statement: str) -> "Recorder":
        self.statements.append(statement)
        return self


def test_duckdb_reads_use_scoped_secrets_and_read_only_attaches() -> None:
    s3 = Resolved(
        id=1,
        name="Lake",
        config=ConnectionConfig(kind="s3", endpoint="https://minio.internal:9000", access_key="AK", path_style=True),
        secret="it's-secret",
    )
    recorder = Recorder()
    reader = remote.S3Reader(
        connection=s3, files=("s3://data/a.parquet",), reader=READERS[".parquet"], scope="s3://data/"
    )
    relation = reader.open(recorder, "remote_0")  # type: ignore[arg-type]
    assert relation == "SELECT * FROM read_parquet(['s3://data/a.parquet'], union_by_name = true)"
    secret = recorder.statements[0]
    assert "ENDPOINT 'minio.internal:9000'" in secret and "USE_SSL true" in secret and "URL_STYLE 'path'" in secret
    assert "SECRET 'it''s-secret'" in secret and "SCOPE 's3://data/'" in secret
    assert "it's-secret" not in repr(reader) and "it's-secret" not in repr(s3)
    postgres = Resolved(
        id=2,
        name="Warehouse",
        config=ConnectionConfig(kind="postgres", host="db", port=5432, database="shop", user="ro", ssl_mode="require"),
        secret=PASSWORD,
    )
    recorder = Recorder()
    table = remote.DatabaseReader(connection=postgres, table="sales.orders", query=None)
    assert table.open(recorder, "remote_1") == 'SELECT * FROM remote_1."sales"."orders"'  # type: ignore[arg-type]
    attach = recorder.statements[1]
    assert (
        "READ_ONLY" in attach and "default_transaction_read_only=on" in attach and "statement_timeout=30000" in attach
    )
    assert PASSWORD not in attach
    query = remote.DatabaseReader(connection=postgres, table=None, query="SELECT id FROM orders;")
    assert query.relation("remote_1") == (
        "SELECT * FROM postgres_query('remote_1', 'SELECT * FROM (SELECT id FROM orders) AS query')"
    )
    iceberg = remote.IcebergReader(connection=s3, root="s3://lake/t", metadata="00002-ab.metadata.json", snapshot=7)
    recorder = Recorder()
    scan = iceberg.open(recorder, "remote_2")  # type: ignore[arg-type]
    assert "iceberg_scan('s3://lake/t', version = '00002-ab'" in scan and "snapshot_from_id = 7" in scan
    assert iceberg.directories == ("s3://lake/t/",)


def test_database_tables_and_queries_are_checked() -> None:
    assert remote.check_table(" public.orders ") == "public.orders"
    with pytest.raises(SourceError):
        remote.check_table("orders; DROP TABLE x")
    assert remote.check_query("WITH a AS (SELECT 1) SELECT * FROM a;") == "WITH a AS (SELECT 1) SELECT * FROM a"
    for bad in ("DELETE FROM orders", "SELECT 1; DELETE FROM orders", "UPDATE x SET y = 1"):
        with pytest.raises(SourceError):
            remote.check_query(bad)
    assert remote.check_column("updated_at") == "updated_at"
    with pytest.raises(SourceError):
        remote.check_column("max(x)")


def test_iceberg_tables_read_their_newest_metadata(bucket: FakeS3) -> None:
    bucket.bucket("lake")
    for version, snapshot in ((1, 11), (2, 22)):
        metadata = {
            "current-snapshot-id": snapshot,
            "snapshots": [
                {"snapshot-id": snapshot, "timestamp-ms": 1_700_000_000_000, "summary": {"total-records": "150"}}
            ],
        }
        bucket.put("lake", f"warehouse/t/metadata/0000{version}-uuid.metadata.json", json.dumps(metadata).encode())
    bucket.put("lake", "warehouse/t/metadata/snap-22.avro", b"")
    state = remote.iceberg_state(resolved(bucket), "s3://lake/warehouse/t/")
    assert (state.reader.metadata, state.reader.snapshot) == ("00002-uuid.metadata.json", 22)
    assert "Snapshot 22, 150 rows" in state.detail
    bucket.put(
        "lake", "warehouse/t/metadata/00003-uuid.metadata.json", json.dumps({"current-snapshot-id": 33}).encode()
    )
    assert remote.iceberg_state(resolved(bucket), "s3://lake/warehouse/t").fingerprint != state.fingerprint
    with pytest.raises(SourceError, match="no Iceberg metadata"):
        remote.iceberg_state(resolved(bucket), "s3://lake/elsewhere")


def test_missing_extensions_are_named_and_never_downloaded(harness: Harness, bucket: FakeS3, tmp_path: Path) -> None:
    bucket.put("data", "exports/jan.parquet", parquet(tmp_path))
    listed = harness.client.get("/api/extensions").json()
    assert {item["name"]: item["installed"] for item in listed["extensions"]}["httpfs"] is False
    assert listed["command"] == extensions.INSTALL_HINT
    connection = s3_connection(harness, bucket)
    response = harness.client.post(
        "/api/sources/s3", json={"connection_id": connection["id"], "path": "s3://data/exports/"}
    )
    assert response.status_code == 422
    assert "httpfs extension is not installed" in response.json()["detail"]
    assert "minibrain extensions install" in response.json()["detail"]
    with duckdb.connect(config=extensions.offline_config()) as duck:
        assert duck.execute("SELECT current_setting('autoinstall_known_extensions')").fetchone() == (False,)


@dataclass(frozen=True)
class FileDatabase:
    connection: Resolved = field(repr=False)
    table: str | None
    query: str | None

    @property
    def extensions(self) -> tuple[str, ...]:
        return ()

    @property
    def paths(self) -> tuple[str, ...]:
        return ()

    @property
    def directories(self) -> tuple[str, ...]:
        return ()

    def open(self, connection: duckdb.DuckDBPyConnection, alias: str) -> str:
        connection.execute(f"ATTACH '{self.connection.config.database}' AS {alias} (READ_ONLY)")
        return f"SELECT * FROM {alias}.main.{self.table}"


@pytest.fixture
def shop(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "shop.duckdb"
    with duckdb.connect(str(path)) as connection:
        connection.execute(
            "CREATE TABLE tickets AS SELECT range AS id, 'ticket ' || range AS body, "
            "(['billing', 'bug', 'account', 'feature'])[range % 4 + 1] AS category, "
            "TIMESTAMP '2026-01-01' + to_minutes(range) AS updated_at FROM range(160)"
        )
    monkeypatch.setattr(remote, "DatabaseReader", FileDatabase)
    return path


def database_connection(harness: Harness, shop: Path) -> dict:
    body = {
        "name": "Shop",
        "kind": "postgres",
        "host": "127.0.0.1",
        "database": str(shop),
        "user": "ro",
        "secret": PASSWORD,
    }
    response = harness.client.post("/api/connections", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def test_database_tables_read_in_place_and_track_changes(harness: Harness, shop: Path) -> None:
    connection = database_connection(harness, shop)
    body = {"connection_id": connection["id"], "table": "tickets", "change_column": "updated_at"}
    response = harness.client.post("/api/sources/database", json=body)
    assert response.status_code == 201, response.text
    source = response.json()
    assert (source["kind"], source["table"], source["rows"], source["connection"]) == (
        "database",
        "tickets",
        160,
        "Shop",
    )
    assert source["fingerprint_detail"].startswith("160 rows, newest updated_at 2026-01-01 02:39:00")
    sql = "SELECT body AS input, category AS label FROM tickets"
    dataset = harness.client.post("/api/datasets", json={"name": "Tickets", "sql": sql}).json()
    assert dataset["rows"] == 160
    saved = harness.client.post(f"/api/datasets/{dataset['slug']}/versions")
    assert saved.status_code == 201, saved.text
    assert saved.json()["rows"] == 160
    assert harness.client.get(f"/api/datasets/{dataset['slug']}").json()["changed"]["data"] is False
    with duckdb.connect(str(shop)) as writer:
        writer.execute("INSERT INTO tickets VALUES (999, 'late ticket', 'bug', TIMESTAMP '2026-02-01')")
    remote.STATES.clear()
    assert harness.client.get(f"/api/datasets/{dataset['slug']}").json()["changed"]["data"] is True
    assert PASSWORD not in json.dumps(harness.client.get("/api/sources").json())
    in_use = harness.client.delete(f"/api/connections/{connection['id']}")
    assert in_use.status_code == 409 and "Tickets" not in in_use.json()["detail"]


def test_database_sources_without_a_change_column_always_count_as_new(harness: Harness, shop: Path) -> None:
    connection = database_connection(harness, shop)
    first = remote.database_state(
        Resolved(id=connection["id"], name="Shop", config=ConnectionConfig(kind="postgres"), secret=""),
        None,
        "SELECT 1",
        None,
    )
    second = remote.database_state(
        Resolved(id=connection["id"], name="Shop", config=ConnectionConfig(kind="postgres"), secret=""),
        None,
        "SELECT 1",
        None,
    )
    assert first.fingerprint != second.fingerprint and "not tracked" in first.detail
    wrong = harness.client.post("/api/sources/s3", json={"connection_id": connection["id"], "path": "s3://x/y"})
    assert wrong.status_code == 422 and "not an S3 connection" in wrong.json()["detail"]
    both = harness.client.post(
        "/api/sources/database", json={"connection_id": connection["id"], "table": "tickets", "query": "SELECT 1"}
    )
    assert both.status_code == 422 and "either a table or a query" in both.json()["detail"]


def model_bucket(fake: FakeS3) -> None:
    fake.bucket("models")
    for name, data in FILES.items():
        fake.put("models", f"qwen/{name}", data)


def test_s3_imports_use_the_matching_connection(
    harness: Harness, bucket: FakeS3, monkeypatch: pytest.MonkeyPatch
) -> None:
    model_bucket(bucket)
    used: list[tuple[str, str]] = []
    real = connection_s3.FILESYSTEMS["s3"]

    def recording(config: ConnectionConfig, secret: str) -> Any:
        used.append((config.endpoint, secret))
        return real(config, secret)

    monkeypatch.setitem(connection_s3.FILESYSTEMS, "s3", recording)
    s3_connection(harness, bucket, name="Other bucket", bucket="elsewhere")
    connection = s3_connection(harness, bucket, name="Models", bucket="models")
    inspected = harness.client.post("/api/models/inspect", json={"location": "s3://models/qwen"}).json()
    assert inspected["ok"] is True, inspected
    assert (inspected["connection"], inspected["files"]) == ("Models", 3)
    assert used == [(bucket.endpoint, SECRET_KEY)]
    row = harness.client.post("/api/models/import", json={"name": "Qwen copy", "location": "s3://models/qwen"})
    assert row.status_code == 202, row.text
    with harness.sessions() as session:
        job = session.query(Job).filter(Job.base_model_id == row.json()["key"]).one()
        assert job.params["connection_id"] == connection["id"]
        assert SECRET_KEY not in json.dumps(job.params)
    claimed = harness.claim(["import"])
    assert claimed is not None
    payload = json.loads(claimed["env"][connection_s3.JOB_ENV])
    assert (payload["secret"], payload["access_key"], payload["endpoint"]) == (SECRET_KEY, ACCESS_KEY, bucket.endpoint)
    assert SECRET_KEY not in json.dumps(claimed["params"])


def test_import_jobs_read_the_bucket_with_the_connection_keys(
    harness: Harness, bucket: FakeS3, monkeypatch: pytest.MonkeyPatch
) -> None:
    model_bucket(bucket)
    for name in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_S3"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("AWS_SHARED_CREDENTIALS_FILE", os.devnull)
    monkeypatch.setenv("AWS_CONFIG_FILE", os.devnull)
    connection = s3_connection(harness, bucket, name="Models", bucket="models")
    body = {"name": "Qwen copy", "location": "s3://models/qwen", "connection_id": connection["id"]}
    row = harness.client.post("/api/models/import", json=body).json()
    assert harness.worker(kinds=["import"]).run_once()
    detail = harness.client.get(f"/api/models/{row['key']}").json()
    assert detail["availability"]["state"] == "available", detail
    assert len(detail["files"]) == 3
    assert SECRET_KEY not in harness.client.get("/api/jobs").text
    with harness.sessions() as session:
        job = session.query(Job).filter(Job.base_model_id == row["key"]).one()
        assert job.status == "succeeded" and SECRET_KEY not in json.dumps(job.params)


def test_the_job_child_reads_its_connection_from_the_environment(
    bucket: FakeS3, monkeypatch: pytest.MonkeyPatch
) -> None:
    from minibrain.models.sources import StorageSource

    model_bucket(bucket)
    monkeypatch.setenv(connection_s3.JOB_ENV, connection_s3.job_env(resolved(bucket, "models"))[connection_s3.JOB_ENV])
    source = StorageSource("s3://models/qwen")
    assert [entry["path"] for entry in source.files()] == sorted(FILES)


@pytest.mark.skipif(
    not os.environ.get("MINIBRAIN_TEST_DUCKDB_EXTENSIONS"), reason="needs a folder of DuckDB extensions"
)
def test_s3_sources_read_through_httpfs(
    harness: Harness, bucket: FakeS3, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(extensions.DIRECTORY_ENV, os.environ["MINIBRAIN_TEST_DUCKDB_EXTENSIONS"])
    bucket.put("data", "httpfs/jan.parquet", parquet(tmp_path))
    connection = s3_connection(harness, bucket)
    source = harness.client.post(
        "/api/sources/s3", json={"connection_id": connection["id"], "path": "s3://data/httpfs/"}
    )
    assert source.status_code == 201, source.text
    assert source.json()["rows"] == 120
