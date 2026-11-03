from pathlib import Path

from fastapi import APIRouter, UploadFile
from sqlalchemy import select

from minibrain.api.deps import SessionDep, SettingsDep, StoreDep
from minibrain.api.schemas import (
    CatalogueUpdate,
    ChatMessage,
    ColumnInfo,
    ColumnStats,
    DatasetCreate,
    DatasetSummary,
    LabelCount,
    MappingUpdate,
    PreviewResponse,
    PreviewRow,
    QualityInfo,
    QueryRequest,
    QueryResponse,
    SampleInfo,
    SourceStats,
    SourceSummary,
)
from minibrain.api.views import mapping_info
from minibrain.artifacts import ArtifactStore
from minibrain.data import quality
from minibrain.data.samples import SAMPLES, add_sample
from minibrain.data.shared import (
    add_dataset,
    add_source,
    dataset_sql,
    get_dataset,
    get_source,
    staging_of,
)
from minibrain.data.sources import (
    describe,
    labelled_rows,
    mapping_sql,
    run_query,
    safe_filename,
    summarize,
    to_text,
)
from minibrain.registry.models import Dataset, Source, now
from minibrain.registry.service import ConflictError
from minibrain.settings import Settings
from minibrain.tasks.classify import trained_messages

router = APIRouter(prefix="/api", tags=["data"])

PREVIEW_ROWS = 20
SOURCE_ROWS = "SELECT * FROM source"
QUERY_ROWS = 50
STATS_SAMPLE = 10_000
LABEL_COUNTS = 200


def columns_of(staging: Path) -> tuple[list[ColumnInfo], int]:
    columns, rows = describe(staging)
    return [ColumnInfo(name=column.name, type=column.type) for column in columns], rows


def source_summary(settings: Settings, store: ArtifactStore, source: Source) -> SourceSummary:
    columns, rows = columns_of(staging_of(settings, store, source))
    return SourceSummary(
        id=source.id,
        kind="upload",
        name=source.name,
        filename=source.filename,
        description=source.description or "",
        tags=source.tags or [],
        size=source.size,
        rows=rows,
        columns=columns,
        datasets=[dataset.slug for dataset in source.datasets],
        created_at=source.created_at,
    )


def known_splits(dataset: Dataset) -> dict[str, int] | None:
    built = [
        snapshot
        for minibrain in dataset.minibrains
        for snapshot in minibrain.snapshots
        if snapshot.created_at >= dataset.updated_at
    ]
    newest = max(built, key=lambda snapshot: snapshot.created_at, default=None)
    return dict(newest.counts) if newest else None


def dataset_summary(settings: Settings, store: ArtifactStore, dataset: Dataset) -> DatasetSummary:
    columns, rows = columns_of(staging_of(settings, store, dataset.source))
    return DatasetSummary(
        slug=dataset.slug,
        name=dataset.name,
        description=dataset.description or "",
        tags=dataset.tags or [],
        source_id=dataset.source_id,
        source_name=dataset.source.name,
        rows=rows,
        columns=columns,
        mapping=mapping_info(dataset),
        models=[minibrain.slug for minibrain in dataset.minibrains],
        splits=known_splits(dataset),
        updated_at=dataset.updated_at,
    )


def clean_tags(tags: list[str]) -> list[str]:
    return sorted({tag.strip() for tag in tags if tag.strip()})


def describe_item(item: Source | Dataset, body: CatalogueUpdate) -> None:
    if body.name is not None:
        item.name = body.name.strip()
    if body.description is not None:
        item.description = body.description.strip() or None
    if body.tags is not None:
        item.tags = clean_tags(body.tags) or None


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
        labels=labels[:LABEL_COUNTS],
        label_counts=[LabelCount(label=label, rows=size) for label, size in quality.label_counts(rows)[:LABEL_COUNTS]],
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


@router.get("/samples")
def list_samples() -> list[SampleInfo]:
    return [SampleInfo(**vars(sample)) for sample in SAMPLES]


@router.post("/samples/{file}", status_code=201)
def add_sample_source(file: str, session: SessionDep, settings: SettingsDep, store: StoreDep) -> SourceSummary:
    source = add_sample(session, store, file)
    summary = source_summary(settings, store, source)
    session.commit()
    return summary


@router.get("/sources/{source_id}")
def read_source(source_id: int, session: SessionDep, settings: SettingsDep, store: StoreDep) -> SourceSummary:
    return source_summary(settings, store, get_source(session, source_id))


@router.patch("/sources/{source_id}")
def update_source(
    source_id: int, body: CatalogueUpdate, session: SessionDep, settings: SettingsDep, store: StoreDep
) -> SourceSummary:
    source = get_source(session, source_id)
    describe_item(source, body)
    session.commit()
    return source_summary(settings, store, source)


@router.get("/sources/{source_id}/rows")
def source_rows(source_id: int, session: SessionDep, settings: SettingsDep, store: StoreDep) -> QueryResponse:
    staging = staging_of(settings, store, get_source(session, source_id))
    return query_rows(staging, SOURCE_ROWS)


@router.get("/sources/{source_id}/stats")
def source_stats(source_id: int, session: SessionDep, settings: SettingsDep, store: StoreDep) -> SourceStats:
    staging = staging_of(settings, store, get_source(session, source_id))
    summaries, sampled = summarize(staging, STATS_SAMPLE)
    return SourceStats(
        rows=describe(staging)[1],
        sampled=sampled,
        columns=[ColumnStats.model_validate(summary, from_attributes=True) for summary in summaries],
    )


@router.post("/sources/{source_id}/query")
def source_query(
    source_id: int, body: QueryRequest, session: SessionDep, settings: SettingsDep, store: StoreDep
) -> QueryResponse:
    return query_rows(staging_of(settings, store, get_source(session, source_id)), body.sql)


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
    mapping = MappingUpdate(input_column=body.input_column, label_column=body.label_column, sql=body.sql)
    if mapping.sql is not None or (mapping.input_column and mapping.label_column):
        apply_mapping(staging_of(settings, store, dataset.source), dataset, mapping)
    session.commit()
    return dataset_summary(settings, store, dataset)


@router.get("/datasets/{slug}")
def read_dataset(slug: str, session: SessionDep, settings: SettingsDep, store: StoreDep) -> DatasetSummary:
    return dataset_summary(settings, store, get_dataset(session, slug))


@router.patch("/datasets/{slug}")
def update_dataset(
    slug: str, body: CatalogueUpdate, session: SessionDep, settings: SettingsDep, store: StoreDep
) -> DatasetSummary:
    dataset = get_dataset(session, slug)
    describe_item(dataset, body)
    session.commit()
    return dataset_summary(settings, store, dataset)


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
