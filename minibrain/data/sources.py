import re
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import duckdb

READERS = {
    ".csv": "read_csv_auto",
    ".tsv": "read_csv_auto",
    ".json": "read_json_auto",
    ".jsonl": "read_json_auto",
    ".ndjson": "read_json_auto",
    ".parquet": "read_parquet",
}
SOURCE_TABLE = "source"
QUERY_TIMEOUT_SECONDS = 30


class SourceError(Exception):
    pass


@dataclass(frozen=True)
class Column:
    name: str
    type: str


@dataclass(frozen=True)
class QueryResult:
    columns: list[str]
    rows: list[list[Any]]


def safe_filename(filename: str) -> str:
    name = Path(filename).name
    if Path(name).suffix.lower() not in READERS:
        raise SourceError("unsupported file type: use CSV, TSV, JSON Lines or Parquet")
    return re.sub(r"[^A-Za-z0-9._-]", "_", name)


def quote_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def quote_identifier(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def stage(file_path: Path, staging_path: Path) -> None:
    reader = READERS[file_path.suffix.lower()]
    staging_path.unlink(missing_ok=True)
    try:
        with duckdb.connect(str(staging_path)) as connection:
            connection.execute(
                f"CREATE TABLE {SOURCE_TABLE} AS SELECT * FROM {reader}({quote_literal(str(file_path))})"
            )
    except duckdb.Error as error:
        staging_path.unlink(missing_ok=True)
        raise SourceError(f"could not read {file_path.name}: {error}") from error


def locked_connection(staging_path: Path) -> duckdb.DuckDBPyConnection:
    return duckdb.connect(
        str(staging_path), read_only=True, config={"enable_external_access": False, "lock_configuration": True}
    )


def describe(staging_path: Path) -> tuple[list[Column], int]:
    with locked_connection(staging_path) as connection:
        columns = [
            Column(name=row[0], type=row[1]) for row in connection.execute(f"DESCRIBE {SOURCE_TABLE}").fetchall()
        ]
        count = connection.execute(f"SELECT count(*) FROM {SOURCE_TABLE}").fetchone()
    return columns, int(count[0]) if count else 0


def run_query(staging_path: Path, sql: str, limit: int | None) -> QueryResult:
    statement = sql.strip().rstrip(";")
    wrapped = f"SELECT * FROM ({statement}) AS query"
    if limit is not None:
        wrapped += f" LIMIT {int(limit)}"
    with locked_connection(staging_path) as connection:
        timer = threading.Timer(QUERY_TIMEOUT_SECONDS, connection.interrupt)
        timer.start()
        try:
            cursor = connection.execute(wrapped)
            columns = [description[0] for description in cursor.description or []]
            rows = [list(row) for row in cursor.fetchall()]
        except duckdb.Error as error:
            raise SourceError(str(error)) from error
        finally:
            timer.cancel()
    return QueryResult(columns=columns, rows=rows)


def mapping_sql(input_column: str, label_column: str) -> str:
    return (
        f"SELECT CAST({quote_identifier(input_column)} AS VARCHAR) AS input, "
        f"CAST({quote_identifier(label_column)} AS VARCHAR) AS label FROM {SOURCE_TABLE}"
    )


def to_text(value: Any) -> str | None:
    return None if value is None else str(value)


def labelled_rows(staging_path: Path, sql: str) -> list[tuple[str | None, str | None]]:
    result = run_query(staging_path, sql, None)
    if "input" not in result.columns or "label" not in result.columns:
        raise SourceError("the query must return an input column and a label column")
    input_index, label_index = result.columns.index("input"), result.columns.index("label")
    return [(to_text(row[input_index]), to_text(row[label_index])) for row in result.rows]
