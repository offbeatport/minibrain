import hashlib
import shutil
from collections.abc import Sequence
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import BinaryIO

from sqlalchemy import ColumnElement, func, select
from sqlalchemy.orm import Session, object_session

from minibrain.artifacts import CHUNK, ArtifactStore, Packing
from minibrain.connections.store import get_connection, resolve
from minibrain.data.dataset_folders import free_dataset_name
from minibrain.data.delta import DELTA, LOG, delta_state, local_path, refuse_remote
from minibrain.data.folders import FolderScan, allowed_roots, check_folder, detect_format, inside, scan
from minibrain.data.names import free_name, same_name
from minibrain.data.remote import (
    DATABASE,
    ICEBERG,
    REMOTE_KINDS,
    S3_SOURCE,
    RemoteState,
    cached,
    check_column,
    check_query,
    check_table,
    database_state,
    iceberg_state,
    require_kind,
    s3_state,
)
from minibrain.data.sources import (
    READERS,
    SOURCE_TABLE,
    SourceError,
    Table,
    describe,
    mapping_sql,
    stage,
    statement_tables,
    table_name_base,
)
from minibrain.registry.files import ArtifactKind, register
from minibrain.registry.models import Artifact, Dataset, DatasetFolder, Minibrain, Snapshot, Source, Version, now
from minibrain.registry.service import ConflictError, NameTakenError, NotFoundError, slugify
from minibrain.settings import Settings

INPUT_NAMES = ("input", "text", "message", "question", "query", "prompt", "utterance", "body", "content")
LABEL_NAMES = ("label", "category", "intent", "class", "target", "topic", "tag")
FOLDER = "folder"
UPLOAD = "upload"


class Outcome(StrEnum):
    CREATED = "created"
    REPLACED = "replaced"
    EXISTING = "existing"


class NameTaken(StrEnum):
    KEEP_BOTH = "keep_both"
    REPLACE = "replace"
    FAIL = "fail"


@dataclass(frozen=True)
class Added:
    source: Source
    outcome: Outcome


def guess(columns: list[str], names: tuple[str, ...]) -> str | None:
    lowered = {column.lower(): column for column in columns}
    return next((lowered[name] for name in names if name in lowered), None)


def staging_key(artifact_id: str, filename: str) -> str:
    return f"{artifact_id}{Path(filename).suffix.lower()}"


def staging_of(store: ArtifactStore, source: Source) -> str:
    artifact_id = str(source.artifact_id)
    key = staging_key(artifact_id, source.filename)
    return store.staged(key, lambda target: stage(store.url(artifact_id, source.filename), target))


def allowed_folder(source: Source) -> Path:
    session = object_session(source)
    if session is None or source.path is None:
        raise SourceError(f"{source.name} has no folder")
    if not inside(Path(source.path), allowed_roots(session)):
        raise SourceError(f"{source.path} is no longer in the folders minibrain may read (Settings, Security)")
    return Path(source.path)


def folder_scan(source: Source) -> FolderScan:
    root = allowed_folder(source)
    return scan(root, source.format or detect_format(root))


def delta_of(source: Source) -> RemoteState:
    return delta_state(allowed_folder(source))


def remote_state(settings: Settings, source: Source) -> RemoteState:
    session = object_session(source)
    if session is None or source.connection is None:
        raise SourceError(f"{source.name} has no connection")
    connection = resolve(session, settings, source.connection)
    key = (
        source.id,
        source.connection.id,
        source.connection.updated_at,
        source.path,
        source.format,
        source.query,
        source.change_column,
    )
    if source.kind == S3_SOURCE:
        return cached(key, lambda: s3_state(connection, source.path or "", source.format))
    if source.kind == ICEBERG:
        return cached(key, lambda: iceberg_state(connection, source.path or ""))
    return cached(key, lambda: database_state(connection, source.path, source.query, source.change_column))


def table_of(settings: Settings, store: ArtifactStore, source: Source) -> Table:
    if source.kind in REMOTE_KINDS or source.kind == DELTA:
        state = delta_of(source) if source.kind == DELTA else remote_state(settings, source)
        return Table(name=source.table_name, fingerprint=state.fingerprint, remote=state.reader)
    if source.kind == FOLDER:
        found = folder_scan(source)
        return Table(
            name=source.table_name,
            files=tuple(item.path for item in found.files),
            reader=READERS[found.format],
            fingerprint=found.fingerprint,
        )
    return Table(name=source.table_name, staging=staging_of(store, source), fingerprint=fingerprint(settings, source))


def fingerprint(settings: Settings, source: Source) -> str:
    if source.kind in REMOTE_KINDS:
        return remote_state(settings, source).fingerprint
    if source.kind == DELTA:
        return delta_of(source).fingerprint
    return folder_scan(source).fingerprint if source.kind == FOLDER else str(source.artifact_id)


def tables_of(settings: Settings, store: ArtifactStore, sources: Sequence[Source]) -> list[Table]:
    return [table_of(settings, store, source) for source in sources]


def aliases_for(sources: Sequence[Source]) -> dict[str, str]:
    return {SOURCE_TABLE: sources[0].table_name} if len(sources) == 1 else {}


def source_columns(settings: Settings, store: ArtifactStore, source: Source) -> list[str]:
    return [column.name for column in describe(table_of(settings, store, source))[0]]


def free_table_name(session: Session, name: str, keep: Source | None = None) -> str:
    base = table_name_base(name)
    taken = {found for found in session.scalars(select(Source.table_name)) if keep is None or found != keep.table_name}
    candidates = (base if number == 1 else f"{base}_{number}" for number in range(1, 10_000))
    return next(candidate for candidate in candidates if candidate not in taken)


def source_named(session: Session, name: str, keep: Source | None = None) -> Source | None:
    found = session.scalars(select(Source).order_by(Source.id))
    return next((source for source in found if source is not keep and same_name(source.name, name)), None)


def free_source_name(session: Session, name: str, keep: Source | None = None) -> str:
    return free_name(name, [source.name for source in session.scalars(select(Source)) if source is not keep])


def taken_error(session: Session, taken: Source, name: str, keep: Source | None = None) -> NameTakenError:
    return NameTakenError(
        f"There is already a source called {taken.name}", taken.name, free_source_name(session, name, keep), taken.id
    )


def require_free_source_name(session: Session, name: str, keep: Source | None = None) -> None:
    taken = source_named(session, name, keep)
    if taken is not None:
        raise taken_error(session, taken, name, keep)


def source_name(session: Session, typed: str | None, derived: str) -> str:
    wanted = (typed or "").strip()
    if not wanted:
        return free_source_name(session, derived)
    require_free_source_name(session, wanted)
    return wanted


def first_source(session: Session, *conditions: ColumnElement[bool]) -> Source | None:
    return session.scalar(select(Source).where(*conditions).order_by(Source.id).limit(1))


def content_hash(stream: BinaryIO) -> str:
    digest = hashlib.sha256()
    while block := stream.read(CHUNK):
        digest.update(block)
    stream.seek(0)
    return digest.hexdigest()


def store_upload(session: Session, store: ArtifactStore, filename: str, stream: BinaryIO, digest: str) -> Artifact:
    stored = store.put_stream(stream, digest)
    return register(session, stored.id, ArtifactKind.SOURCE, Packing.FILE, filename, stored.size)


def artifact_in_use(session: Session, artifact_id: str) -> bool:
    references = (Source.artifact_id, Snapshot.artifact_id, Version.adapter_artifact_id)
    return any(
        session.scalar(select(column).where(column == artifact_id).limit(1)) is not None for column in references
    )


def release_upload(session: Session, store: ArtifactStore, artifact_id: str | None, filename: str) -> None:
    session.flush()
    if artifact_id is None or artifact_in_use(session, artifact_id):
        return
    found = session.get(Artifact, artifact_id)
    if found is None or found.kind != ArtifactKind.SOURCE:
        return
    session.delete(found)
    store.delete(artifact_id)
    shutil.rmtree(store.staged_path(staging_key(artifact_id, filename)), ignore_errors=True)


def replace_upload(
    session: Session, store: ArtifactStore, source: Source, filename: str, stream: BinaryIO, digest: str
) -> None:
    if source.kind != UPLOAD:
        raise ConflictError(f"{source.name} is not an uploaded file, so a file cannot replace it; keep both instead")
    previous, previous_name = source.artifact_id, source.filename
    artifact = store_upload(session, store, filename, stream, digest)
    source.filename = filename
    source.artifact_id = artifact.id
    source.size = artifact.size
    release_upload(session, store, previous, previous_name)


def add_source(
    session: Session,
    store: ArtifactStore,
    filename: str,
    stream: BinaryIO,
    name_taken: NameTaken = NameTaken.KEEP_BOTH,
) -> Added:
    digest = content_hash(stream)
    same = first_source(session, Source.artifact_id == digest)
    if same is not None:
        return Added(same, Outcome.EXISTING)
    clash = source_named(session, filename)
    if clash is not None and name_taken == NameTaken.FAIL:
        raise taken_error(session, clash, filename)
    if clash is not None and name_taken == NameTaken.REPLACE:
        replace_upload(session, store, clash, filename, stream, digest)
        return Added(clash, Outcome.REPLACED)
    name = free_source_name(session, filename)
    artifact = store_upload(session, store, filename, stream, digest)
    source = Source(
        name=name,
        filename=filename,
        table_name=free_table_name(session, name),
        artifact_id=artifact.id,
        size=artifact.size,
    )
    session.add(source)
    session.flush()
    return Added(source, Outcome.CREATED)


def add_folder(session: Session, path: str, name: str | None, format: str | None) -> Added:
    root = check_folder(session, path)
    if (root / LOG).is_dir():
        raise SourceError(
            f"{root} is a Delta Lake table: add it as a Lakehouse table, so minibrain reads its current version "
            "rather than every file in it"
        )
    chosen = format or detect_format(root)
    if chosen not in READERS:
        raise SourceError("pick CSV, TSV, JSON, JSON Lines or Parquet")
    same = first_source(session, Source.kind == FOLDER, Source.path == str(root), Source.format == chosen)
    if same is not None:
        return Added(same, Outcome.EXISTING)
    found = scan(root, chosen)
    label = source_name(session, name, root.name or str(root))
    source = Source(
        name=label,
        filename=root.name or str(root),
        table_name=free_table_name(session, label),
        kind=FOLDER,
        path=str(root),
        format=chosen,
        size=found.size,
    )
    session.add(source)
    session.flush()
    return Added(source, Outcome.CREATED)


def add_delta(session: Session, path: str, name: str | None) -> Added:
    refuse_remote(path)
    root = check_folder(session, local_path(path))
    same = first_source(session, Source.kind == DELTA, Source.path == str(root))
    if same is not None:
        return Added(same, Outcome.EXISTING)
    state = delta_state(root)
    label = source_name(session, name, root.name or str(root))
    source = Source(
        name=label,
        filename=root.name or str(root),
        table_name=free_table_name(session, label),
        kind=DELTA,
        path=str(root),
    )
    session.add(source)
    session.flush()
    describe(Table(name=source.table_name, fingerprint=state.fingerprint, remote=state.reader))
    return Added(source, Outcome.CREATED)


def add_remote(
    session: Session,
    settings: Settings,
    kind: str,
    connection_id: int,
    name: str | None,
    path: str | None = None,
    format: str | None = None,
    query: str | None = None,
    change_column: str | None = None,
) -> Added:
    connection = get_connection(session, connection_id)
    require_kind(kind, resolve(session, settings, connection))
    if format is not None and format not in READERS:
        raise SourceError("pick CSV, TSV, JSON, JSON Lines or Parquet")
    if kind == DATABASE:
        table = check_table(path) if path and path.strip() else None
        query = check_query(query) if query and query.strip() else None
        if (table is None) == (query is None):
            raise SourceError("give either a table or a query")
        path, change_column = table, check_column(change_column)
        label = table or "query"
    else:
        path = (path or "").strip()
        label = path.rstrip("/").rsplit("/", 1)[-1] or path
    same = same_remote(session, kind, connection_id, path, format, query)
    if same is not None:
        return Added(same, Outcome.EXISTING)
    title = source_name(session, name, connection.name if label == "query" else label)
    source = Source(
        name=title,
        filename=label,
        table_name=free_table_name(session, title),
        kind=kind,
        connection=connection,
        path=path,
        format=format,
        query=query,
        change_column=change_column,
    )
    session.add(source)
    session.flush()
    state = remote_state(settings, source)
    source.size = state.size
    if kind == S3_SOURCE and source.format is None:
        source.format = state.format
    describe(Table(name=source.table_name, fingerprint=state.fingerprint, remote=state.reader))
    return Added(source, Outcome.CREATED)


def same_remote(
    session: Session, kind: str, connection_id: int, path: str | None, format: str | None, query: str | None
) -> Source | None:
    location = Source.path.is_not_distinct_from(path)
    if kind in (S3_SOURCE, ICEBERG) and path is not None:
        location = func.rtrim(Source.path, "/") == path.rstrip("/")
    conditions = [Source.kind == kind, Source.connection_id == connection_id, location]
    if kind == DATABASE:
        conditions.append(Source.query.is_not_distinct_from(query))
    if format is not None:
        conditions.append(Source.format == format)
    return first_source(session, *conditions)


def free_slug(session: Session, name: str) -> str:
    base = slugify(name) or "dataset"
    taken = set(session.scalars(select(Dataset.slug)))
    candidates = (base if number == 1 else f"{base}-{number}" for number in range(1, 10_000))
    return next(candidate for candidate in candidates if candidate not in taken)


def map_columns(settings: Settings, store: ArtifactStore, dataset: Dataset, source: Source) -> None:
    columns = source_columns(settings, store, source)
    input_column, label_column = guess(columns, INPUT_NAMES), guess(columns, LABEL_NAMES)
    dataset.source = source
    dataset.sources = [source]
    dataset.input_column = input_column
    dataset.label_column = label_column
    dataset.sql = mapping_sql(input_column, label_column, source.table_name) if input_column and label_column else None
    dataset.updated_at = now()


def add_dataset(
    session: Session,
    settings: Settings,
    store: ArtifactStore,
    name: str,
    source: Source | None,
    folder: DatasetFolder | None = None,
) -> Dataset:
    dataset = Dataset(slug=free_slug(session, name), name=name, folder_id=folder.id if folder is not None else None)
    session.add(dataset)
    session.flush()
    if source is not None:
        map_columns(settings, store, dataset, source)
    return dataset


def sources_in(session: Session, sql: str, fallback: Sequence[Source] = ()) -> list[Source]:
    names = statement_tables(sql)
    found = [source for source in session.scalars(select(Source)) if source.table_name.lower() in names]
    if SOURCE_TABLE in names and len(fallback) == 1 and fallback[0] not in found:
        found.append(fallback[0])
    if not found:
        raise SourceError("the query reads no source: use one of the table names listed beside the editor")
    return sorted(found, key=lambda source: source.table_name)


def attach_upload(
    session: Session,
    settings: Settings,
    store: ArtifactStore,
    minibrain: Minibrain,
    filename: str,
    stream: BinaryIO,
) -> Dataset:
    source = add_source(session, store, filename, stream).source
    dataset = minibrain.dataset
    if dataset is not None and len(dataset.minibrains) == 1:
        map_columns(settings, store, dataset, source)
        return dataset
    created = add_dataset(session, settings, store, free_dataset_name(session, minibrain.name, None), source)
    minibrain.dataset = created
    return created


def dataset_of(minibrain: Minibrain) -> Dataset:
    if minibrain.dataset is None:
        raise ConflictError("upload a data file or pick a dataset first")
    return minibrain.dataset


def dataset_sql(dataset: Dataset) -> str:
    if not dataset.sql:
        raise ConflictError("map an input column and a label column first")
    return dataset.sql


def dataset_tables(settings: Settings, store: ArtifactStore, dataset: Dataset) -> tuple[list[Table], dict[str, str]]:
    return tables_of(settings, store, dataset.sources), aliases_for(dataset.sources)


def get_dataset(session: Session, slug: str) -> Dataset:
    found = session.scalar(select(Dataset).where(Dataset.slug == slug))
    if found is None:
        raise NotFoundError(f"no dataset called {slug}")
    return found


def get_source(session: Session, source_id: int) -> Source:
    found = session.get(Source, source_id)
    if found is None:
        raise NotFoundError(f"no source {source_id}")
    return found
