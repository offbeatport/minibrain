from collections.abc import Sequence
from pathlib import Path
from typing import BinaryIO

from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.artifacts import ArtifactStore, Packing
from minibrain.data.sources import (
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
from minibrain.registry.models import Dataset, Minibrain, Source, now
from minibrain.registry.service import ConflictError, NotFoundError, slugify
from minibrain.settings import Settings

INPUT_NAMES = ("input", "text", "message", "question", "query", "prompt", "utterance", "body", "content")
LABEL_NAMES = ("label", "category", "intent", "class", "target", "topic", "tag")


def guess(columns: list[str], names: tuple[str, ...]) -> str | None:
    lowered = {column.lower(): column for column in columns}
    return next((lowered[name] for name in names if name in lowered), None)


def staging_of(settings: Settings, store: ArtifactStore, source: Source) -> Path:
    key = f"{source.artifact_id}{Path(source.filename).suffix.lower()}"
    staging = settings.home / "staging" / key / "staging.duckdb"
    if not staging.exists():
        staging.parent.mkdir(parents=True, exist_ok=True)
        stage(store.materialize(str(source.artifact_id), Packing.FILE, source.filename), staging)
    return staging


def table_of(settings: Settings, store: ArtifactStore, source: Source) -> Table:
    return Table(name=source.table_name, staging=staging_of(settings, store, source), fingerprint=fingerprint(source))


def fingerprint(source: Source) -> str:
    return str(source.artifact_id)


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


def add_source(session: Session, store: ArtifactStore, filename: str, stream: BinaryIO) -> Source:
    stored = store.put_stream(stream)
    artifact = register(session, stored.id, ArtifactKind.SOURCE, Packing.FILE, filename, stored.size)
    source = Source(
        name=filename,
        filename=filename,
        table_name=free_table_name(session, filename),
        artifact_id=artifact.id,
        size=stored.size,
    )
    session.add(source)
    session.flush()
    return source


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
    session: Session, settings: Settings, store: ArtifactStore, name: str, source: Source | None
) -> Dataset:
    fallback = source.name if source is not None else "New dataset"
    dataset = Dataset(slug=free_slug(session, name.strip() or fallback), name=name.strip() or fallback)
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
    source = add_source(session, store, filename, stream)
    dataset = minibrain.dataset
    if dataset is not None and len(dataset.minibrains) == 1:
        map_columns(settings, store, dataset, source)
        return dataset
    created = add_dataset(session, settings, store, minibrain.name, source)
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
