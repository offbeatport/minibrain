from pathlib import Path
from typing import BinaryIO

from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.artifacts import ArtifactStore, Packing
from minibrain.data.sources import describe, mapping_sql, stage
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
        stage(store.materialize(source.artifact_id, Packing.FILE, source.filename), staging)
    return staging


def add_source(session: Session, store: ArtifactStore, filename: str, stream: BinaryIO) -> Source:
    stored = store.put_stream(stream)
    artifact = register(session, stored.id, ArtifactKind.SOURCE, Packing.FILE, filename, stored.size)
    source = Source(name=filename, filename=filename, artifact_id=artifact.id, size=stored.size)
    session.add(source)
    session.flush()
    return source


def free_slug(session: Session, name: str) -> str:
    base = slugify(name) or "dataset"
    taken = set(session.scalars(select(Dataset.slug)))
    candidates = (base if number == 1 else f"{base}-{number}" for number in range(1, 10_000))
    return next(candidate for candidate in candidates if candidate not in taken)


def map_columns(settings: Settings, store: ArtifactStore, dataset: Dataset) -> None:
    columns = [column.name for column in describe(staging_of(settings, store, dataset.source))[0]]
    input_column, label_column = guess(columns, INPUT_NAMES), guess(columns, LABEL_NAMES)
    dataset.input_column = input_column
    dataset.label_column = label_column
    dataset.sql = mapping_sql(input_column, label_column) if input_column and label_column else None
    dataset.updated_at = now()


def add_dataset(session: Session, settings: Settings, store: ArtifactStore, name: str, source: Source) -> Dataset:
    dataset = Dataset(slug=free_slug(session, name), name=name.strip() or source.name, source=source)
    session.add(dataset)
    session.flush()
    map_columns(settings, store, dataset)
    return dataset


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
        dataset.source = source
        map_columns(settings, store, dataset)
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
