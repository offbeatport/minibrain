import json
import re
import threading
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from functools import lru_cache
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
TABLE_NAME_LENGTH = 48


class SourceError(Exception):
    pass


@dataclass(frozen=True)
class Column:
    name: str
    type: str


@dataclass(frozen=True)
class ColumnSummary:
    name: str
    type: str
    nulls: int
    distinct: int
    min: str | None
    max: str | None


@dataclass(frozen=True)
class QueryResult:
    columns: list[str]
    rows: list[list[Any]]


@dataclass(frozen=True)
class Table:
    name: str
    staging: Path | None = None
    files: tuple[str, ...] = ()
    reader: str = ""
    fingerprint: str = ""


@dataclass(frozen=True)
class Quality:
    rows: int
    empty: int
    duplicates: int
    labels: int
    smallest_label: int
    largest_label: int
    mean_input_chars: float


def safe_filename(filename: str) -> str:
    name = Path(filename).name
    if Path(name).suffix.lower() not in READERS:
        raise SourceError("unsupported file type: use CSV, TSV, JSON Lines or Parquet")
    return re.sub(r"[^A-Za-z0-9._-]", "_", name)


def quote_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def quote_identifier(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


@lru_cache(maxsize=1)
def reserved_words() -> frozenset[str]:
    with duckdb.connect() as connection:
        found = connection.execute(
            "SELECT keyword_name FROM duckdb_keywords() WHERE keyword_category IN ('reserved', 'type_function')"
        ).fetchall()
    return frozenset(str(row[0]).lower() for row in found)


def table_name_base(name: str) -> str:
    stem = Path(name).stem if Path(name).suffix.lower() in READERS else name
    base = re.sub(r"[^a-z0-9]+", "_", stem.lower()).strip("_")[:TABLE_NAME_LENGTH].strip("_") or "data"
    if base[0].isdigit():
        base = f"t_{base}"
    if base in reserved_words() or base == SOURCE_TABLE:
        base = f"{base}_data"
    return base


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


def file_list(files: Sequence[str]) -> str:
    return "[" + ", ".join(quote_literal(file) for file in files) + "]"


def table_relation(table: Table, attached: str) -> str:
    if table.staging is not None:
        return f"SELECT * FROM {attached}.{SOURCE_TABLE}"
    if not table.files:
        raise SourceError(f"{table.name} has no files to read")
    return f"SELECT * FROM {table.reader}({file_list(table.files)}, union_by_name = true)"


def connect(tables: Sequence[Table], aliases: dict[str, str] | None = None) -> duckdb.DuckDBPyConnection:
    connection = duckdb.connect()
    try:
        readable: list[str] = []
        for index, table in enumerate(tables):
            attached = f"staged_{index}"
            if table.staging is not None:
                connection.execute(f"ATTACH {quote_literal(str(table.staging))} AS {attached} (READ_ONLY)")
            readable += table.files
            connection.execute(f"CREATE VIEW {quote_identifier(table.name)} AS {table_relation(table, attached)}")
        if readable:
            connection.execute(f"SET allowed_paths = {file_list(readable)}")
        names = {table.name for table in tables}
        for alias, target in (aliases or {}).items():
            if target in names and alias not in names:
                connection.execute(f"CREATE VIEW {quote_identifier(alias)} AS SELECT * FROM {quote_identifier(target)}")
        connection.execute("SET enable_external_access = false")
        connection.execute("SET lock_configuration = true")
    except duckdb.Error as error:
        connection.close()
        raise SourceError(str(error)) from error
    return connection


@contextmanager
def sandbox(tables: Sequence[Table], aliases: dict[str, str] | None = None) -> Iterator[duckdb.DuckDBPyConnection]:
    connection = connect(tables, aliases)
    timer = threading.Timer(QUERY_TIMEOUT_SECONDS, connection.interrupt)
    timer.start()
    try:
        yield connection
    except duckdb.InterruptException as error:
        raise SourceError(f"the query ran for more than {QUERY_TIMEOUT_SECONDS} seconds and was stopped") from error
    except duckdb.Error as error:
        raise SourceError(str(error)) from error
    finally:
        timer.cancel()
        connection.close()


def base_tables(node: Any, found: set[str]) -> set[str]:
    if isinstance(node, dict):
        if node.get("type") == "BASE_TABLE" and isinstance(node.get("table_name"), str):
            found.add(node["table_name"].lower())
        for value in node.values():
            base_tables(value, found)
    elif isinstance(node, list):
        for value in node:
            base_tables(value, found)
    return found


def statement_tables(sql: str) -> set[str]:
    with duckdb.connect(config={"enable_external_access": False}) as connection:
        found = connection.execute("SELECT json_serialize_sql(?)", [sql.strip().rstrip(";")]).fetchone()
    parsed = json.loads(found[0]) if found else {"error": True, "error_message": "empty query"}
    if parsed.get("error"):
        message = str(parsed.get("error_message") or "the query could not be read")
        if "Only SELECT" in message:
            message = "only a single SELECT query can run here"
        raise SourceError(message)
    statements = parsed.get("statements") or []
    if len(statements) != 1:
        raise SourceError("write one SELECT query, without a second statement after a semicolon")
    return base_tables(statements, set())


def wrapped(sql: str, limit: int | None = None) -> str:
    statement = sql.strip().rstrip(";")
    statement_tables(statement)
    query = f"SELECT * FROM ({statement}) AS query"
    return query if limit is None else f"{query} LIMIT {int(limit)}"


def describe(table: Table) -> tuple[list[Column], int]:
    with sandbox([table]) as connection:
        name = quote_identifier(table.name)
        columns = [Column(name=row[0], type=row[1]) for row in connection.execute(f"DESCRIBE {name}").fetchall()]
        count = connection.execute(f"SELECT count(*) FROM {name}").fetchone()
    return columns, int(count[0]) if count else 0


def summarize(table: Table, sample: int) -> tuple[list[ColumnSummary], int]:
    with sandbox([table]) as connection:
        cursor = connection.execute(f"SUMMARIZE (SELECT * FROM {quote_identifier(table.name)} LIMIT {int(sample)})")
        names = [description[0] for description in cursor.description or []]
        found = [dict(zip(names, row, strict=True)) for row in cursor.fetchall()]
    sampled = int(found[0]["count"]) if found else 0
    summaries = []
    for row in found:
        nulls = round(sampled * float(row["null_percentage"] or 0) / 100)
        summaries.append(
            ColumnSummary(
                name=row["column_name"],
                type=row["column_type"],
                nulls=nulls,
                distinct=min(int(row["approx_unique"] or 0), sampled - nulls),
                min=clip(row["min"]),
                max=clip(row["max"]),
            )
        )
    return summaries, sampled


def clip(value: Any, limit: int = 80) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if len(text) <= limit else f"{text[: limit - 1]}…"


def run_query(
    tables: Sequence[Table], sql: str, limit: int | None, aliases: dict[str, str] | None = None
) -> QueryResult:
    query = wrapped(sql, limit)
    with sandbox(tables, aliases) as connection:
        cursor = connection.execute(query)
        columns = [description[0] for description in cursor.description or []]
        rows = [list(row) for row in cursor.fetchall()]
    return QueryResult(columns=columns, rows=rows)


def output_columns(tables: Sequence[Table], sql: str, aliases: dict[str, str] | None = None) -> list[Column]:
    query = wrapped(sql, 0)
    with sandbox(tables, aliases) as connection:
        found = connection.execute(f"DESCRIBE {query}").fetchall()
    return [Column(name=row[0], type=row[1]) for row in found]


def require_mapping(columns: Sequence[Column]) -> None:
    names = {column.name for column in columns}
    if "input" not in names or "label" not in names:
        raise SourceError("the query must return an input column and a label column")


def count_rows(tables: Sequence[Table], sql: str, aliases: dict[str, str] | None = None) -> int:
    query = wrapped(sql)
    with sandbox(tables, aliases) as connection:
        found = connection.execute(f"SELECT count(*) FROM ({query})").fetchone()
    return int(found[0]) if found else 0


def labelled_query(sql: str) -> str:
    return f"SELECT CAST(input AS VARCHAR) AS input, CAST(label AS VARCHAR) AS label FROM ({wrapped(sql)})"


def usable_query(sql: str) -> str:
    return (
        f"SELECT trim(input) AS input, trim(label) AS label FROM ({labelled_query(sql)}) "
        "WHERE coalesce(trim(input), '') <> '' AND coalesce(trim(label), '') <> ''"
    )


def assess(tables: Sequence[Table], sql: str, aliases: dict[str, str] | None = None) -> Quality:
    require_mapping(output_columns(tables, sql, aliases))
    with sandbox(tables, aliases) as connection:
        found = connection.execute(
            f"WITH everything AS ({labelled_query(sql)}), usable AS ({usable_query(sql)}), "
            "per_label AS (SELECT label, count(*) AS rows FROM usable GROUP BY label) "
            "SELECT (SELECT count(*) FROM everything), (SELECT count(*) FROM usable), "
            "(SELECT count(DISTINCT input) FROM usable), (SELECT count(*) FROM per_label), "
            "(SELECT coalesce(min(rows), 0) FROM per_label), (SELECT coalesce(max(rows), 0) FROM per_label), "
            "(SELECT coalesce(avg(length(input)), 0) FROM usable)"
        ).fetchone()
    rows, usable, distinct, labels, smallest, largest, mean = found or (0, 0, 0, 0, 0, 0, 0.0)
    return Quality(
        rows=int(rows),
        empty=int(rows) - int(usable),
        duplicates=int(usable) - int(distinct),
        labels=int(labels),
        smallest_label=int(smallest),
        largest_label=int(largest),
        mean_input_chars=float(mean),
    )


def label_counts(
    tables: Sequence[Table], sql: str, limit: int, aliases: dict[str, str] | None = None
) -> list[tuple[str, int]]:
    with sandbox(tables, aliases) as connection:
        found = connection.execute(
            f"SELECT label, count(*) AS rows FROM ({usable_query(sql)}) GROUP BY label "
            f"ORDER BY rows DESC, label LIMIT {int(limit)}"
        ).fetchall()
    return [(str(label), int(rows)) for label, rows in found]


def table_identifier(name: str) -> str:
    plain = re.fullmatch(r"[a-z_][a-z0-9_]*", name) and name not in reserved_words()
    return name if plain else quote_identifier(name)


def mapping_sql(input_column: str, label_column: str, table: str = SOURCE_TABLE) -> str:
    return (
        f"SELECT CAST({quote_identifier(input_column)} AS VARCHAR) AS input, "
        f"CAST({quote_identifier(label_column)} AS VARCHAR) AS label FROM {table_identifier(table)}"
    )


def to_text(value: Any) -> str | None:
    return None if value is None else str(value)


def labelled_rows(
    tables: Sequence[Table], sql: str, aliases: dict[str, str] | None = None, limit: int | None = None
) -> list[tuple[str | None, str | None]]:
    result = run_query(tables, sql, limit, aliases)
    if "input" not in result.columns or "label" not in result.columns:
        raise SourceError("the query must return an input column and a label column")
    input_index, label_index = result.columns.index("input"), result.columns.index("label")
    return [(to_text(row[input_index]), to_text(row[label_index])) for row in result.rows]
