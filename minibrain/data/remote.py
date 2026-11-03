import hashlib
import json
import re
import threading
import time
from collections import Counter
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlparse

import duckdb

from minibrain.connections.s3 import filesystem
from minibrain.connections.spec import DATABASES, MYSQL, POSTGRES, S3
from minibrain.connections.store import Resolved
from minibrain.data.extensions import ExtensionMissingError, load, offline_connection
from minibrain.data.folders import MAX_FILES, family
from minibrain.data.sources import (
    QUERY_TIMEOUT_SECONDS,
    READERS,
    SourceError,
    Table,
    file_list,
    quote_identifier,
    quote_literal,
    sandbox,
)

S3_SOURCE = "s3"
DATABASE = "database"
ICEBERG = "iceberg"
REMOTE_KINDS = (S3_SOURCE, DATABASE, ICEBERG)
STATE_SECONDS = 30.0
GLOB = re.compile(r"[*?\[]")
QUERY_START = re.compile(r"^\s*(select|with)\b", re.IGNORECASE)
METADATA = re.compile(r"^v?(\d+)[-.].*metadata\.json$")
IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]*$")
CONNECTION_KINDS = {S3_SOURCE: (S3,), ICEBERG: (S3,), DATABASE: DATABASES}


@dataclass(frozen=True)
class RemoteState:
    fingerprint: str
    detail: str
    files: int | None = None
    size: int = 0
    modified_at: datetime | None = None
    format: str | None = None
    reader: Any = field(default=None, repr=False, compare=False)


def digest(lines: list[str]) -> str:
    found = hashlib.sha256()
    for line in lines:
        found.update(f"{line}\n".encode())
    return found.hexdigest()


def plain_message(error: Exception) -> str:
    text = str(error).strip() or type(error).__name__
    if isinstance(error, FileNotFoundError) and " " not in text:
        text = f"nothing is stored at {text}"
    return text if len(text) <= 300 else f"{text[:299]}…"


def s3_secret(name: str, connection: Resolved, scope: str) -> str:
    config = connection.config
    endpoint = urlparse(config.endpoint_url)
    parts = [
        "TYPE s3",
        f"KEY_ID {quote_literal(config.access_key)}",
        f"SECRET {quote_literal(connection.secret)}",
        f"REGION {quote_literal(config.region or 'us-east-1')}",
        f"ENDPOINT {quote_literal(endpoint.netloc)}",
        f"URL_STYLE {quote_literal('path' if config.path_style else 'vhost')}",
        f"USE_SSL {'true' if endpoint.scheme == 'https' else 'false'}",
        f"SCOPE {quote_literal(scope)}",
    ]
    return f"CREATE SECRET {name} ({', '.join(parts)})"


def database_secret(name: str, connection: Resolved) -> str:
    config = connection.config
    parts = [
        f"TYPE {config.kind}",
        f"HOST {quote_literal(config.host)}",
        f"PORT {int(config.port or 0)}",
        f"DATABASE {quote_literal(config.database)}",
        f"USER {quote_literal(config.user)}",
        f"PASSWORD {quote_literal(connection.secret)}",
    ]
    return f"CREATE SECRET {name} ({', '.join(parts)})"


def database_options(connection: Resolved) -> str:
    config = connection.config
    if config.kind == POSTGRES:
        settings = f"-c default_transaction_read_only=on -c statement_timeout={QUERY_TIMEOUT_SECONDS * 1000}"
        return f"sslmode={config.ssl_mode} connect_timeout=10 options='{settings}'"
    return f"ssl_mode={config.ssl_mode}"


@dataclass(frozen=True)
class S3Reader:
    connection: Resolved = field(repr=False)
    files: tuple[str, ...]
    reader: str
    scope: str

    @property
    def extensions(self) -> tuple[str, ...]:
        return ("httpfs",)

    @property
    def paths(self) -> tuple[str, ...]:
        return self.files

    @property
    def directories(self) -> tuple[str, ...]:
        return ()

    def open(self, connection: duckdb.DuckDBPyConnection, alias: str) -> str:
        connection.execute(s3_secret(alias, self.connection, self.scope))
        return f"SELECT * FROM {self.reader}({file_list(self.files)}, union_by_name = true)"


def split_table(table: str, default_schema: str) -> tuple[str, str]:
    schema, _, name = table.strip().rpartition(".")
    return (schema or default_schema), name


def table_reference(alias: str, table: str, connection: Resolved) -> str:
    default = connection.config.database if connection.config.kind == MYSQL else "public"
    schema, name = split_table(table, default)
    return f"{alias}.{quote_identifier(schema)}.{quote_identifier(name)}"


@dataclass(frozen=True)
class DatabaseReader:
    connection: Resolved = field(repr=False)
    table: str | None
    query: str | None

    @property
    def extensions(self) -> tuple[str, ...]:
        return ("postgres_scanner",) if self.connection.config.kind == POSTGRES else ("mysql_scanner",)

    @property
    def paths(self) -> tuple[str, ...]:
        return ()

    @property
    def directories(self) -> tuple[str, ...]:
        return ()

    def relation(self, alias: str) -> str:
        if self.query is not None:
            function = "postgres_query" if self.connection.config.kind == POSTGRES else "mysql_query"
            inner = f"SELECT * FROM ({self.query.strip().rstrip(';')}) AS query"
            return f"SELECT * FROM {function}({quote_literal(alias)}, {quote_literal(inner)})"
        return f"SELECT * FROM {table_reference(alias, self.table or '', self.connection)}"

    def open(self, connection: duckdb.DuckDBPyConnection, alias: str) -> str:
        attach_database(connection, self.connection, alias)
        return self.relation(alias)


def attach_database(duck: duckdb.DuckDBPyConnection, connection: Resolved, alias: str) -> None:
    duck.execute(database_secret(alias, connection))
    options = quote_literal(database_options(connection))
    duck.execute(f"ATTACH {options} AS {alias} (TYPE {connection.config.kind}, SECRET {alias}, READ_ONLY)")


@dataclass(frozen=True)
class IcebergReader:
    connection: Resolved = field(repr=False)
    root: str
    metadata: str
    snapshot: int | None

    @property
    def extensions(self) -> tuple[str, ...]:
        return ("httpfs", "iceberg")

    @property
    def paths(self) -> tuple[str, ...]:
        return ()

    @property
    def directories(self) -> tuple[str, ...]:
        return (f"{self.root}/",)

    def open(self, connection: duckdb.DuckDBPyConnection, alias: str) -> str:
        connection.execute(s3_secret(alias, self.connection, f"{self.root}/"))
        compressed = self.metadata.endswith(".gz.metadata.json")
        version = self.metadata.removesuffix(".metadata.json").removesuffix(".gz")
        arguments = [
            quote_literal(self.root),
            f"version = {quote_literal(version)}",
            "version_name_format = '%s%s.metadata.json'",
            "allow_moved_paths = true",
        ]
        if compressed:
            arguments.append("metadata_compression_codec = 'gzip'")
        if self.snapshot is not None:
            arguments.append(f"snapshot_from_id = {int(self.snapshot)}")
        return f"SELECT * FROM iceberg_scan({', '.join(arguments)})"


def require_kind(source_kind: str, connection: Resolved) -> None:
    if connection.config.kind not in CONNECTION_KINDS[source_kind]:
        wanted = "an S3 connection" if source_kind in (S3_SOURCE, ICEBERG) else "a PostgreSQL or MySQL connection"
        raise SourceError(f"{connection.name} is not {wanted}")


def parse_s3(path: str, connection: Resolved) -> tuple[str, str]:
    cleaned = path.strip()
    if not cleaned.startswith("s3://"):
        raise SourceError("an S3 path starts with s3://, such as s3://bucket/exports/*.parquet")
    bucket, _, rest = cleaned.removeprefix("s3://").partition("/")
    if not bucket:
        raise SourceError("the S3 path needs a bucket, such as s3://bucket/exports/*.parquet")
    expected = connection.config.bucket
    if expected and bucket != expected:
        raise SourceError(f"{connection.name} is for the bucket {expected}; this path is in {bucket}")
    return bucket, rest


def pattern_suffix(rest: str) -> str | None:
    leaf = rest.rstrip("/").rsplit("/", 1)[-1]
    dot = leaf.rfind(".")
    suffix = leaf[dot:].lower() if dot >= 0 else ""
    return suffix if suffix in READERS else None


def hidden(key: str) -> bool:
    return any(part.startswith((".", "_")) for part in key.split("/")[1:])


def listing(connection: Resolved, bucket: str, rest: str) -> dict[str, dict[str, Any]]:
    fs = filesystem(connection)
    target = f"{bucket}/{rest}"
    try:
        if GLOB.search(rest) or pattern_suffix(rest):
            found = fs.glob(target, detail=True)
        else:
            found = fs.find(target.rstrip("/"), detail=True)
    except Exception as error:
        raise SourceError(f"could not list s3://{target} with {connection.name}: {plain_message(error)}") from error
    return found if isinstance(found, dict) else {}


def s3_objects(connection: Resolved, path: str, format: str | None) -> tuple[str, list[dict[str, Any]], str]:
    bucket, rest = parse_s3(path, connection)
    entries = [
        info
        for name, info in sorted(listing(connection, bucket, rest).items())
        if info.get("type", "file") == "file" and not hidden(name)
    ]
    chosen = format or pattern_suffix(rest)
    if chosen is None:
        counts = Counter(
            family(suffix)[0]
            for suffix in (pattern_suffix(str(info.get("name") or "")) for info in entries)
            if suffix is not None
        )
        if not counts:
            raise SourceError(f"s3://{bucket}/{rest} has no CSV, TSV, JSON, JSON Lines or Parquet files")
        chosen = counts.most_common(1)[0][0]
    suffixes = family(chosen)
    kept = [info for info in entries if pattern_suffix(str(info.get("name") or "")) in suffixes]
    if not kept:
        raise SourceError(f"no {chosen} files match s3://{bucket}/{rest}")
    if len(kept) > MAX_FILES:
        raise SourceError(f"s3://{bucket}/{rest} matches more than {MAX_FILES:,} files; narrow the path")
    return chosen, kept, bucket


def modified(info: dict[str, Any]) -> datetime | None:
    value = info.get("LastModified")
    return value.astimezone(UTC) if isinstance(value, datetime) else None


def s3_state(connection: Resolved, path: str, format: str | None) -> RemoteState:
    chosen, kept, bucket = s3_objects(connection, path, format)
    lines = [f"{info['name']}\t{int(info.get('size') or 0)}\t{info.get('ETag') or ''}" for info in kept]
    urls = tuple(f"s3://{info['name']}" for info in kept)
    size = sum(int(info.get("size") or 0) for info in kept)
    newest = max((stamp for stamp in (modified(info) for info in kept) if stamp), default=None)
    reader = S3Reader(connection=connection, files=urls, reader=READERS[chosen], scope=f"s3://{bucket}/")
    return RemoteState(
        fingerprint=digest(lines),
        detail=f"{len(kept):,} objects; changes are tracked by their ETags and sizes",
        files=len(kept),
        size=size,
        modified_at=newest,
        format=chosen,
        reader=reader,
    )


def check_query(query: str) -> str:
    cleaned = query.strip().rstrip(";").strip()
    if not QUERY_START.match(cleaned):
        raise SourceError("the query must be one SELECT (or WITH … SELECT); nothing is ever written to the database")
    if ";" in cleaned:
        raise SourceError("write one query, without a second statement after a semicolon")
    return cleaned


def check_table(table: str) -> str:
    parts = table.strip().split(".")
    if not table.strip() or len(parts) > 2 or not all(IDENTIFIER.match(part) for part in parts):
        raise SourceError("give the table as name or schema.name, using letters, digits and underscores")
    return table.strip()


def check_column(column: str | None) -> str | None:
    cleaned = (column or "").strip()
    if not cleaned:
        return None
    if not IDENTIFIER.match(cleaned):
        raise SourceError("the updated-at column is a plain column name")
    return cleaned


def database_state(
    connection: Resolved, table: str | None, query: str | None, change_column: str | None
) -> RemoteState:
    reader = DatabaseReader(connection=connection, table=table, query=query)
    if change_column is None:
        read_at = datetime.now(UTC)
        definition = query if query is not None else f"table {table}"
        return RemoteState(
            fingerprint=digest([definition, read_at.isoformat()]),
            detail="Changes are not tracked without an updated-at column, so every read counts as new data",
            modified_at=read_at,
            reader=reader,
        )
    probe = Table(name="probe", remote=reader)
    with sandbox([probe]) as duck:
        found = duck.execute(
            f"SELECT count(*), CAST(max({quote_identifier(change_column)}) AS VARCHAR) FROM probe"
        ).fetchone()
    rows, newest = (int(found[0]), found[1]) if found else (0, None)
    return RemoteState(
        fingerprint=digest([str(rows), str(newest)]),
        detail=f"{rows:,} rows, newest {change_column} {newest or 'none'}",
        reader=reader,
    )


def metadata_version(name: str) -> int | None:
    found = METADATA.match(name)
    return int(found.group(1)) if found else None


def iceberg_state(connection: Resolved, path: str) -> RemoteState:
    bucket, rest = parse_s3(path, connection)
    root = f"{bucket}/{rest.strip('/')}"
    fs = filesystem(connection)
    try:
        names = [str(item).rsplit("/", 1)[-1] for item in fs.ls(f"{root}/metadata", detail=False)]
    except FileNotFoundError:
        names = []
    except Exception as error:
        raise SourceError(
            f"could not read s3://{root}/metadata with {connection.name}: {plain_message(error)}"
        ) from error
    versions = sorted((version, name) for name in names if (version := metadata_version(name)) is not None)
    if not versions:
        raise SourceError(f"s3://{root} has no Iceberg metadata files; give the table's folder")
    metadata = versions[-1][1]
    try:
        with fs.open(f"{root}/metadata/{metadata}", "rb") as stream:
            raw = stream.read()
        if metadata.endswith(".gz.metadata.json"):
            import gzip

            raw = gzip.decompress(raw)
        table = json.loads(raw)
    except Exception as error:
        raise SourceError(f"could not read s3://{root}/metadata/{metadata}: {plain_message(error)}") from error
    current = table.get("current-snapshot-id")
    snapshot = int(current) if isinstance(current, int) and current >= 0 else None
    entry = next((item for item in table.get("snapshots") or [] if item.get("snapshot-id") == snapshot), {})
    records = (entry.get("summary") or {}).get("total-records")
    stamp = entry.get("timestamp-ms")
    reader = IcebergReader(connection=connection, root=f"s3://{root}", metadata=metadata, snapshot=snapshot)
    detail = f"Snapshot {snapshot}" if snapshot is not None else "No snapshot yet"
    return RemoteState(
        fingerprint=digest([f"s3://{root}", str(snapshot)]),
        detail=f"{detail}{f', {int(records):,} rows' if records else ''}; changes are tracked by the snapshot id",
        modified_at=datetime.fromtimestamp(stamp / 1000, UTC) if isinstance(stamp, int) else None,
        reader=reader,
    )


SYSTEM_SCHEMAS = ("information_schema", "pg_catalog", "pg_toast", "performance_schema", "mysql", "sys")
TABLE_LIST_LIMIT = 1000


@contextmanager
def timed(duck: duckdb.DuckDBPyConnection) -> Iterator[duckdb.DuckDBPyConnection]:
    timer = threading.Timer(QUERY_TIMEOUT_SECONDS, duck.interrupt)
    timer.start()
    try:
        yield duck
    except duckdb.InterruptException as error:
        raise SourceError(f"the database did not answer within {QUERY_TIMEOUT_SECONDS} seconds") from error
    except duckdb.Error as error:
        raise SourceError(plain_message(error)) from error
    finally:
        timer.cancel()
        duck.close()


def database_tables(connection: Resolved) -> list[str]:
    reader = DatabaseReader(connection=connection, table=None, query=None)
    duck = offline_connection()
    try:
        load(duck, reader.extensions)
    except ExtensionMissingError as error:
        duck.close()
        raise SourceError(str(error)) from error
    with timed(duck):
        attach_database(duck, connection, "probe")
        found = duck.execute(
            "SELECT schema_name, table_name FROM duckdb_tables() WHERE database_name = 'probe' "
            f"UNION ALL SELECT schema_name, view_name FROM duckdb_views() WHERE database_name = 'probe' "
            f"ORDER BY 1, 2 LIMIT {TABLE_LIST_LIMIT}"
        ).fetchall()
    own = connection.config.database if connection.config.kind == MYSQL else None
    default = own or "public"
    return [
        name if schema == default else f"{schema}.{name}"
        for schema, name in found
        if str(schema).lower() not in SYSTEM_SCHEMAS and (own is None or schema == own)
    ]


def probe(connection: Resolved) -> str:
    config = connection.config
    if config.kind == S3:
        fs = filesystem(connection)
        try:
            if config.bucket:
                entries = fs.ls(config.bucket, detail=False)
                return f"Listed s3://{config.bucket} at {config.endpoint_url}: {len(entries):,} entries at the top."
            buckets = fs.ls("", detail=False)
        except Exception as error:
            raise SourceError(f"could not reach {config.summary}: {plain_message(error)}") from error
        return f"Connected to {config.endpoint_url}; {len(buckets):,} buckets visible."
    tables = database_tables(connection)
    return f"Connected to {config.summary}; {len(tables):,} tables and views visible."


STATES: dict[tuple[Any, ...], tuple[float, RemoteState]] = {}
STATES_LOCK = threading.Lock()


def cached(key: tuple[Any, ...], build: Callable[[], RemoteState]) -> RemoteState:
    moment = time.monotonic()
    with STATES_LOCK:
        found = STATES.get(key)
        if found is not None and found[0] > moment:
            return found[1]
    state = build()
    with STATES_LOCK:
        STATES[key] = (moment + STATE_SECONDS, state)
        for stale in [item for item, (expires, _) in STATES.items() if expires <= moment]:
            STATES.pop(stale, None)
    return state


def forget(source_id: int) -> None:
    with STATES_LOCK:
        for key in [key for key in STATES if key[0] == source_id]:
            STATES.pop(key, None)
