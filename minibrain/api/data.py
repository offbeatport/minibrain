from pathlib import Path

from fastapi import APIRouter, UploadFile
from sqlalchemy import select

from minibrain.api.deps import SessionDep, SettingsDep, StoreDep
from minibrain.api.schemas import (
    ChatMessage,
    ColumnInfo,
    DatasetCreate,
    DatasetSummary,
    MappingUpdate,
    PreviewResponse,
    PreviewRow,
    QualityInfo,
    QueryRequest,
    QueryResponse,
    SourceSummary,
)
from minibrain.api.views import mapping_info
from minibrain.artifacts import ArtifactStore
from minibrain.data import quality
from minibrain.data.shared import (
    add_dataset,
    add_source,
    dataset_sql,
    get_dataset,
    get_source,
    staging_of,
)
from minibrain.data.sources import describe, labelled_rows, mapping_sql, run_query, safe_filename, to_text
from minibrain.registry.models import Dataset, Source, now
from minibrain.registry.service import ConflictError
from minibrain.settings import Settings
from minibrain.tasks.classify import trained_messages

router = APIRouter(prefix="/api", tags=["data"])

PREVIEW_ROWS = 20
SOURCE_ROWS = "SELECT * FROM source"
QUERY_ROWS = 50


def columns_of(staging: Path) -> tuple[list[ColumnInfo], int]:
    columns, rows = describe(staging)
    return [ColumnInfo(name=column.name, type=column.type) for column in columns], rows


def source_summary(settings: Settings, store: ArtifactStore, source: Source) -> SourceSummary:
    columns, rows = columns_of(staging_of(settings, store, source))
    return SourceSummary(
        id=source.id,
        name=source.name,
        filename=source.filename,
        size=source.size,
        rows=rows,
        columns=columns,
        datasets=[dataset.slug for dataset in source.datasets],
        created_at=source.created_at,
    )


def dataset_summary(settings: Settings, store: ArtifactStore, dataset: Dataset) -> DatasetSummary:
    columns, rows = columns_of(staging_of(settings, store, dataset.source))
    return DatasetSummary(
        slug=dataset.slug,
        name=dataset.name,
        source_id=dataset.source_id,
        source_name=dataset.source.name,
        rows=rows,
        columns=columns,
        mapping=mapping_info(dataset),
        models=[minibrain.slug for minibrain in dataset.minibrains],
        updated_at=dataset.updated_at,
    )


def apply_mapping(staging: Path, dataset: Dataset, body: MappingUpdate) -> None:
    if body.sql is not None:
        run_query(staging, body.sql, 1)
        dataset.sql = body.sql
        dataset.input_column = None
        dataset.label_column = None
    elif body.input_column and body.label_column:
        sql = mapping_sql(body.input_column, body.label_column)
        run_query(staging, sql, 1)
        dataset.input_column = body.input_column
        dataset.label_column = body.label_column
        dataset.sql = sql
    else:
        raise ConflictError("send an input column and a label column, or SQL")
    dataset.updated_at = now()


def query_rows(staging: Path, sql: str) -> QueryResponse:
    result = run_query(staging, sql, QUERY_ROWS)
    return QueryResponse(columns=result.columns, rows=[[to_text(value) for value in row] for row in result.rows])


def preview_of(staging: Path, sql: str) -> PreviewResponse:
    rows = labelled_rows(staging, sql)
    assessed = quality.assess(rows)
    labels = sorted({label.strip() for _, label in rows if label and label.strip()})
    first = next((text for text, label in rows if text and label), "")
    return PreviewResponse(
        rows=[PreviewRow(input=text, label=label) for text, label in rows[:PREVIEW_ROWS]],
        quality=QualityInfo.model_validate(assessed, from_attributes=True),
        labels=labels[:200],
        example=[ChatMessage.model_validate(message) for message in trained_messages(first)],
    )


@router.get("/sources")
def list_sources(session: SessionDep, settings: SettingsDep, store: StoreDep) -> list[SourceSummary]:
    found = session.scalars(select(Source).order_by(Source.id.desc()))
    return [source_summary(settings, store, source) for source in found]


@router.post("/sources", status_code=201)
def upload_source(file: UploadFile, session: SessionDep, settings: SettingsDep, store: StoreDep) -> SourceSummary:
    source = add_source(session, store, safe_filename(file.filename or ""), file.file)
    summary = source_summary(settings, store, source)
    session.commit()
    return summary


@router.get("/sources/{source_id}")
def read_source(source_id: int, session: SessionDep, settings: SettingsDep, store: StoreDep) -> SourceSummary:
    return source_summary(settings, store, get_source(session, source_id))


@router.get("/sources/{source_id}/rows")
def source_rows(source_id: int, session: SessionDep, settings: SettingsDep, store: StoreDep) -> QueryResponse:
    staging = staging_of(settings, store, get_source(session, source_id))
    return query_rows(staging, SOURCE_ROWS)


@router.delete("/sources/{source_id}", status_code=204)
def delete_source(source_id: int, session: SessionDep) -> None:
    source = get_source(session, source_id)
    if source.datasets:
        names = ", ".join(dataset.name for dataset in source.datasets)
        raise ConflictError(f"{source.name} is used by {names}; delete those datasets first")
    session.delete(source)
    session.commit()


@router.get("/datasets")
def list_datasets(session: SessionDep, settings: SettingsDep, store: StoreDep) -> list[DatasetSummary]:
    found = session.scalars(select(Dataset).order_by(Dataset.name))
    return [dataset_summary(settings, store, dataset) for dataset in found]


@router.post("/datasets", status_code=201)
def create_dataset(body: DatasetCreate, session: SessionDep, settings: SettingsDep, store: StoreDep) -> DatasetSummary:
    dataset = add_dataset(session, settings, store, body.name, get_source(session, body.source_id))
    session.commit()
    return dataset_summary(settings, store, dataset)


@router.get("/datasets/{slug}")
def read_dataset(slug: str, session: SessionDep, settings: SettingsDep, store: StoreDep) -> DatasetSummary:
    return dataset_summary(settings, store, get_dataset(session, slug))


@router.put("/datasets/{slug}/mapping")
def update_dataset_mapping(
    slug: str, body: MappingUpdate, session: SessionDep, settings: SettingsDep, store: StoreDep
) -> DatasetSummary:
    dataset = get_dataset(session, slug)
    apply_mapping(staging_of(settings, store, dataset.source), dataset, body)
    session.commit()
    return dataset_summary(settings, store, dataset)


@router.get("/datasets/{slug}/preview")
def dataset_preview(slug: str, session: SessionDep, settings: SettingsDep, store: StoreDep) -> PreviewResponse:
    dataset = get_dataset(session, slug)
    return preview_of(staging_of(settings, store, dataset.source), dataset_sql(dataset))


@router.post("/datasets/{slug}/query")
def dataset_query(
    slug: str, body: QueryRequest, session: SessionDep, settings: SettingsDep, store: StoreDep
) -> QueryResponse:
    return query_rows(staging_of(settings, store, get_dataset(session, slug).source), body.sql)


@router.delete("/datasets/{slug}", status_code=204)
def delete_dataset(slug: str, session: SessionDep) -> None:
    dataset = get_dataset(session, slug)
    if dataset.minibrains:
        names = ", ".join(minibrain.name for minibrain in dataset.minibrains)
        raise ConflictError(f"{dataset.name} is used by {names}; pick another dataset for them first")
    session.delete(dataset)
    session.commit()
