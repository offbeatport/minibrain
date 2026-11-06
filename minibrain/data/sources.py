import json
import re
import threading
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Protocol

import duckdb

from minibrain.data.extensions import ExtensionMissingError, load, offline_config
from minibrain.encryption.duck import register

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
BLOCKED_FUNCTIONS = ("query", "query_table", "which_secret")
BLOCKED_PREFIXES = ("postgres_", "mysql_", "iceberg_", "delta_", "sqlite_", "duckdb_secrets")


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


class Remote(Protocol):
    @property
    def extensions(self) -> tuple[str, ...]: ...

    @property
    def paths(self) -> tuple[str, ...]: ...

    @property
    def directories(self) -> tuple[str, ...]: ...

    def open(self, connection: duckdb.DuckDBPyConnection, alias: str) -> str: ...


@dataclass(frozen=True)
class Table:
    name: str
    staging: str | None = None
    files: tuple[str, ...] = ()
    reader: str = ""
    fingerprint: str = ""
    remote: Remote | None = field(default=None, repr=False, compare=False)


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


def stage(source: str | Path, staging_path: Path) -> None:
    name = Path(str(source)).name
    reader = READERS[Path(name).suffix.lower()]
    staging_path.unlink(missing_ok=True)
    try:
        with duckdb.connect(str(staging_path)) as connection:
            register(connection)
            connection.execute(f"CREATE TABLE {SOURCE_TABLE} AS SELECT * FROM {reader}({quote_literal(str(source))})")
    except duckdb.Error as error:
        staging_path.unlink(missing_ok=True)
        raise SourceError(f"could not read {name}: {error}") from error


def file_list(files: Sequence[str]) -> str:
    return "[" + ", ".join(quote_literal(file) for file in files) + "]"


def table_relation(connection: duckdb.DuckDBPyConnection, table: Table, attached: str) -> str:
    if table.remote is not None:
        load(connection, table.remote.extensions)
        return table.remote.open(connection, f"remote_{attached}")
    if table.staging is not None:
        return f"SELECT * FROM {attached}.{SOURCE_TABLE}"
    if not table.files:
        raise SourceError(f"{table.name} has no files to read")
    return f"SELECT * FROM {table.reader}({file_list(table.files)}, union_by_name = true)"


def connect(
    tables: Sequence[Table], aliases: dict[str, str] | None = None, output: Path | None = None
) -> duckdb.DuckDBPyConnection:
    connection = duckdb.connect(config=offline_config())
    try:
        register(connection)
        readable: list[str] = []
        directories: list[str] = [str(output) + "/"] if output is not None else []
        for index, table in enumerate(tables):
            attached = f"staged_{index}"
            if table.staging is not None:
                connection.execute(f"ATTACH {quote_literal(table.staging)} AS {attached} (READ_ONLY)")
            readable += table.files
            if table.remote is not None:
                readable += table.remote.paths
                directories += table.remote.directories
            relation = table_relation(connection, table, attached)
            connection.execute(f"CREATE VIEW {quote_identifier(table.name)} AS {relation}")
        if readable:
            connection.execute(f"SET allowed_paths = {file_list(readable)}")
        if directories:
            connection.execute(f"SET allowed_directories = {file_list(directories)}")
        names = {table.name for table in tables}
        for alias, target in (aliases or {}).items():
            if target in names and alias not in names:
                connection.execute(f"CREATE VIEW {quote_identifier(alias)} AS SELECT * FROM {quote_identifier(target)}")
        connection.execute("SET enable_external_access = false")
        connection.execute("SET lock_configuration = true")
    except ExtensionMissingError as error:
        connection.close()
        raise SourceError(str(error)) from error
    except duckdb.Error as error:
        connection.close()
        raise SourceError(str(error)) from error
    return connection


@contextmanager
def sandbox(
    tables: Sequence[Table], aliases: dict[str, str] | None = None, output: Path | None = None
) -> Iterator[duckdb.DuckDBPyConnection]:
    connection = connect(tables, aliases, output)
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


def check_reference(node: dict[str, Any]) -> None:
    if node.get("type") == "BASE_TABLE":
        catalog, schema = str(node.get("catalog_name") or ""), str(node.get("schema_name") or "")
        if catalog or schema.lower() not in ("", "main"):
            qualified = ".".join(part for part in (catalog, schema, str(node.get("table_name") or "")) if part)
            raise SourceError(f"refer to sources by their table name alone, not {qualified}")
    function = node.get("function") if node.get("type") == "TABLE_FUNCTION" else None
    name = str(function.get("function_name") or "").lower() if isinstance(function, dict) else ""
    if name in BLOCKED_FUNCTIONS or name.startswith(BLOCKED_PREFIXES):
        raise SourceError(f"{name} cannot be used in dataset SQL; read sources by their table names")


def base_tables(node: Any, found: set[str]) -> set[str]:
    if isinstance(node, dict):
        check_reference(node)
        if node.get("type") == "BASE_TABLE" and isinstance(node.get("table_name"), str):
            found.add(node["table_name"].lower())
        for value in node.values():
            base_tables(value, found)
    elif isinstance(node, list):
        for value in node:
            base_tables(value, found)
    return found


def error_context(statement: str, position: int) -> str:
    before = statement.encode()[:position].decode(errors="ignore").split("\n")
    line = statement.split("\n")[len(before) - 1].rstrip("\r")
    prefix = f"LINE {len(before)}: "
    return f"\n\n{prefix}{line}\n{' ' * (len(prefix) + len(before[-1]))}^"


def statement_tables(sql: str) -> set[str]:
    statement = sql.strip().rstrip(";")
    with duckdb.connect(config={"enable_external_access": False}) as connection:
        found = connection.execute("SELECT json_serialize_sql(?)", [statement]).fetchone()
    parsed = json.loads(found[0]) if found else {"error": True, "error_message": "empty query"}
    if parsed.get("error"):
        message = str(parsed.get("error_message") or "the query could not be read")
        if "Only SELECT" in message:
            message = "only a single SELECT query can run here"
        elif str(parsed.get("position", "")).isdigit():
            message += error_context(statement, int(parsed["position"]))
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
    tables: Sequence[Table], sql: str, limit: int | None, aliases: dict[str, str] | None = None, as_text: bool = False
) -> QueryResult:
    query = wrapped(sql, limit)
    if as_text:
        query = f"SELECT COLUMNS(*)::VARCHAR FROM ({query})"
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


MESSAGES_COLUMN = "messages"
PAIR = "pair"
CHAT = "chat"
CHAT_SHAPE = '[{"role":"VARCHAR","content":"VARCHAR"}]'
TEXT_TYPES = ("VARCHAR", "JSON")
EXAMPLE_COLUMNS = ("messages", "input", "expected")
NOT_EXAMPLES = "the query must return an input column and a label column, or a messages column of chat turns"


def shape_of(columns: Sequence[Column]) -> str:
    names = {column.name for column in columns}
    if MESSAGES_COLUMN in names:
        return CHAT
    if "input" in names and "label" in names:
        return PAIR
    raise SourceError(NOT_EXAMPLES)


def require_mapping(columns: Sequence[Column]) -> None:
    shape_of(columns)


def pair_examples(sql: str, limit: int | None = None) -> str:
    text, answer = "trim(CAST(input AS VARCHAR))", "trim(CAST(label AS VARCHAR))"
    return (
        f"SELECT to_json([{{'role': 'user', 'content': {text}}}])::VARCHAR AS messages, {text} AS input, "
        f"{answer} AS expected FROM ({wrapped(sql, limit)})"
    )


def chat_examples(sql: str, column: Column, limit: int | None = None) -> str:
    raw = "CAST(messages AS VARCHAR)" if column.type in TEXT_TYPES else "to_json(messages)::VARCHAR"
    prompt = "list_slice(t, 1, len(t) - 1)"
    lines = f"array_to_string(list_transform({prompt}, lambda x: x.role || ': ' || x.content), chr(10))"
    return (
        f"WITH parsed AS (SELECT list_filter(from_json(try_cast({raw} AS JSON), {quote_literal(CHAT_SHAPE)}), "
        f"lambda x: x.role <> 'system') AS t FROM ({wrapped(sql, limit)})) "
        f"SELECT to_json({prompt})::VARCHAR AS messages, "
        f"CASE WHEN len(t) = 2 THEN t[1].content ELSE {lines} END AS input, "
        "CASE WHEN t[len(t)].role = 'assistant' THEN t[len(t)].content END AS expected FROM parsed"
    )


def examples_query(sql: str, columns: Sequence[Column], limit: int | None = None) -> str:
    if shape_of(columns) == CHAT:
        return chat_examples(sql, next(column for column in columns if column.name == MESSAGES_COLUMN), limit)
    return pair_examples(sql, limit)


def usable_examples(examples: str) -> str:
    return f"SELECT * FROM ({examples}) WHERE coalesce(trim(input), '') <> '' AND coalesce(trim(expected), '') <> ''"


def count_rows(tables: Sequence[Table], sql: str, aliases: dict[str, str] | None = None) -> int:
    query = wrapped(sql)
    with sandbox(tables, aliases) as connection:
        found = connection.execute(f"SELECT count(*) FROM ({query})").fetchone()
    return int(found[0]) if found else 0


def assess(tables: Sequence[Table], sql: str, aliases: dict[str, str] | None = None) -> Quality:
    examples = examples_query(sql, output_columns(tables, sql, aliases))
    with sandbox(tables, aliases) as connection:
        found = connection.execute(
            f"WITH everything AS ({examples}), usable AS ({usable_examples(examples)}), "
            "per_label AS (SELECT expected, count(*) AS rows FROM usable GROUP BY expected) "
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
    examples = examples_query(sql, output_columns(tables, sql, aliases))
    with sandbox(tables, aliases) as connection:
        found = connection.execute(
            f"SELECT expected, count(*) AS rows FROM ({usable_examples(examples)}) GROUP BY expected "
            f"ORDER BY rows DESC, expected LIMIT {int(limit)}"
        ).fetchall()
    return [(str(label), int(rows)) for label, rows in found]


def table_identifier(name: str) -> str:
    plain = re.fullmatch(r"[a-z_][a-z0-9_]*", name) and name not in reserved_words()
    return name if plain else quote_identifier(name)


def select_from(expressions: Sequence[tuple[str, str]], table: str) -> str:
    listed = ", ".join(f"{expression} AS {alias}" for expression, alias in expressions)
    return f"SELECT {listed} FROM {table_identifier(table)}"


def to_text(value: Any) -> str | None:
    return None if value is None else str(value)


ExampleRow = tuple[str | None, str | None, str | None]


def example_rows(
    tables: Sequence[Table], sql: str, aliases: dict[str, str] | None = None, limit: int | None = None
) -> list[ExampleRow]:
    examples = examples_query(sql, output_columns(tables, sql, aliases), limit)
    with sandbox(tables, aliases) as connection:
        found = connection.execute(f"SELECT messages, input, expected FROM ({examples})").fetchall()
    return [(to_text(messages), to_text(text), to_text(expected)) for messages, text, expected in found]


def copy_rows(
    tables: Sequence[Table], sql: str, target: Path, limit: int, aliases: dict[str, str] | None = None
) -> int:
    examples = examples_query(sql, output_columns(tables, sql, aliases), limit + 1)
    rows = f"SELECT messages, input, expected FROM ({examples}) ORDER BY ALL"
    with sandbox(tables, aliases, target.parent) as connection:
        connection.execute(
            f"COPY ({rows}) TO {quote_literal(str(target))} (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000)"
        )
    with duckdb.connect() as connection:
        found = connection.execute("SELECT count(*) FROM read_parquet(?)", [str(target)]).fetchone()
    return int(found[0]) if found else 0


FEEDBACK_CHANGES = (
    "CREATE TABLE changes AS SELECT f.* FROM feedback_rows f WHERE f.split IS NOT NULL OR NOT ("
    "EXISTS (SELECT 1 FROM dataset d WHERE trim(d.input) = f.input AND d.expected = f.expected) AND NOT EXISTS "
    "(SELECT 1 FROM dataset d WHERE trim(d.input) = f.input AND d.expected IS DISTINCT FROM f.expected))"
)
FEEDBACK_MERGED = (
    "SELECT * FROM (SELECT * FROM dataset WHERE input IS NULL OR trim(input) NOT IN (SELECT input FROM changes) "
    "UNION ALL BY NAME SELECT * FROM changes) ORDER BY ALL"
)


def merge_rows(target: Path, rows: Sequence[tuple[str, str, str, str | None]]) -> tuple[int, int]:
    merged = target.with_name(f"merged-{target.name}")
    with duckdb.connect() as connection:
        connection.execute(f"CREATE VIEW dataset AS SELECT * FROM read_parquet({quote_literal(str(target))})")
        connection.execute(
            "CREATE TABLE feedback_rows (messages VARCHAR, input VARCHAR, expected VARCHAR, split VARCHAR)"
        )
        connection.executemany("INSERT INTO feedback_rows VALUES (?, ?, ?, ?)", list(rows))
        connection.execute(FEEDBACK_CHANGES)
        found = connection.execute("SELECT count(*) FROM changes").fetchone()
        changed = int(found[0]) if found else 0
        if changed:
            connection.execute(
                f"COPY ({FEEDBACK_MERGED}) TO {quote_literal(str(merged))} "
                "(FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000)"
            )
    if changed:
        merged.replace(target)
    with duckdb.connect() as connection:
        total = connection.execute("SELECT count(*) FROM read_parquet(?)", [str(target)]).fetchone()
    return (int(total[0]) if total else 0), changed
