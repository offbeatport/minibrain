from collections.abc import Sequence
from functools import lru_cache

from fastapi import APIRouter, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

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
    SourceRef,
    SourceStats,
    SourceSummary,
)
from minibrain.api.views import mapping_info
from minibrain.artifacts import ArtifactStore
from minibrain.data.samples import SAMPLES, add_sample
from minibrain.data.shared import (
    add_dataset,
    add_source,
    aliases_for,
    dataset_sql,
    dataset_tables,
    get_dataset,
    get_source,
    sources_in,
    table_of,
    tables_of,
)
from minibrain.data.sources import (
    SourceError,
    Table,
    assess,
    count_rows,
    describe,
    label_counts,
    labelled_rows,
    mapping_sql,
    output_columns,
    require_mapping,
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


Aliases = tuple[tuple[str, str], ...]


@lru_cache(maxsize=512)
def cached_shape(tables: tuple[Table, ...], aliases: Aliases, sql: str) -> tuple[tuple[ColumnInfo, ...], int]:
    columns = output_columns(tables, sql, dict(aliases))
    rows = count_rows(tables, sql, dict(aliases))
    return tuple(ColumnInfo(name=column.name, type=column.type) for column in columns), rows


@lru_cache(maxsize=512)
def cached_describe(table: Table) -> tuple[tuple[ColumnInfo, ...], int]:
    columns, rows = describe(table)
    return tuple(ColumnInfo(name=column.name, type=column.type) for column in columns), rows


def source_ref(source: Source) -> SourceRef:
    return SourceRef(id=source.id, name=source.name, table=source.table_name, kind="upload")


def source_summary(settings: Settings, store: ArtifactStore, source: Source) -> SourceSummary:
    columns, rows = cached_describe(table_of(settings, store, source))
    return SourceSummary(
        id=source.id,
        kind="upload",
        name=source.name,
        filename=source.filename,
        table=source.table_name,
        description=source.description or "",
        tags=source.tags or [],
        size=source.size,
        rows=rows,
        columns=list(columns),
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


def dataset_shape(
    settings: Settings, store: ArtifactStore, dataset: Dataset
) -> tuple[list[ColumnInfo], int | None, str | None]:
    if not dataset.sql or not dataset.sources:
        return [], None, None
    try:
        tables, aliases = dataset_tables(settings, store, dataset)
        columns, rows = cached_shape(tuple(tables), tuple(aliases.items()), dataset.sql)
    except SourceError as error:
        return [], None, str(error)
    return list(columns), rows, None


def dataset_summary(settings: Settings, store: ArtifactStore, dataset: Dataset) -> DatasetSummary:
    columns, rows, problem = dataset_shape(settings, store, dataset)
    columns_mode = bool(dataset.input_column and dataset.label_column) or not dataset.sql
    return DatasetSummary(
        slug=dataset.slug,
        name=dataset.name,
        description=dataset.description or "",
        tags=dataset.tags or [],
        mode="columns" if columns_mode else "sql",
        source_id=dataset.source_id,
        sources=[source_ref(source) for source in dataset.sources],
        rows=rows,
        columns=columns,
        error=problem,
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


def column_source(session: Session, dataset: Dataset, body: MappingUpdate) -> Source:
    if body.source_id is not None:
        return get_source(session, body.source_id)
    current = dataset.source or (dataset.sources[0] if dataset.sources else None)
    if current is None:
        raise ConflictError("pick the source the columns come from")
    return current


def check_mapping(tables: Sequence[Table], aliases: dict[str, str], sql: str) -> None:
    require_mapping(output_columns(tables, sql, aliases))
    run_query(tables, sql, 1, aliases)


def apply_mapping(
    session: Session, settings: Settings, store: ArtifactStore, dataset: Dataset, body: MappingUpdate
) -> None:
    if body.sql is not None:
        sources = sources_in(session, body.sql, dataset.sources)
        check_mapping(tables_of(settings, store, sources), aliases_for(sources), body.sql)
        dataset.sql = body.sql
        dataset.sources = sources
        dataset.source = sources[0] if len(sources) == 1 else None
        dataset.input_column = None
        dataset.label_column = None
    elif body.input_column and body.label_column:
        source = column_source(session, dataset, body)
        sql = mapping_sql(body.input_column, body.label_column, source.table_name)
        check_mapping([table_of(settings, store, source)], {}, sql)
        dataset.source = source
        dataset.sources = [source]
        dataset.input_column = body.input_column
        dataset.label_column = body.label_column
        dataset.sql = sql
    else:
        raise ConflictError("send an input column and a label column, or SQL")
    dataset.updated_at = now()


def query_rows(tables: Sequence[Table], sql: str, aliases: dict[str, str] | None = None) -> QueryResponse:
    result = run_query(tables, sql, QUERY_ROWS, aliases)
    return QueryResponse(columns=result.columns, rows=[[to_text(value) for value in row] for row in result.rows])


def preview_of(tables: Sequence[Table], aliases: dict[str, str], sql: str) -> PreviewResponse:
    quality = assess(tables, sql, aliases)
    rows = labelled_rows(tables, sql, aliases, PREVIEW_ROWS)
    counts = label_counts(tables, sql, LABEL_COUNTS, aliases)
    first = next((text for text, label in rows if text and label), "")
    return PreviewResponse(
        rows=[PreviewRow(input=text, label=label) for text, label in rows],
        quality=QualityInfo.model_validate(quality, from_attributes=True),
        labels=sorted(label for label, _ in counts),
        label_counts=[LabelCount(label=label, rows=size) for label, size in counts],
        example=[ChatMessage.model_validate(message) for message in trained_messages(first)],
    )


def dataset_preview_of(settings: Settings, store: ArtifactStore, dataset: Dataset) -> PreviewResponse:
    tables, aliases = dataset_tables(settings, store, dataset)
    return preview_of(tables, aliases, dataset_sql(dataset))


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
    source = get_source(session, source_id)
    return query_rows([table_of(settings, store, source)], SOURCE_ROWS, aliases_for([source]))


@router.get("/sources/{source_id}/stats")
def source_stats(source_id: int, session: SessionDep, settings: SettingsDep, store: StoreDep) -> SourceStats:
    table = table_of(settings, store, get_source(session, source_id))
    summaries, sampled = summarize(table, STATS_SAMPLE)
    return SourceStats(
        rows=cached_describe(table)[1],
        sampled=sampled,
        columns=[ColumnStats.model_validate(summary, from_attributes=True) for summary in summaries],
    )


@router.post("/sources/{source_id}/query")
def source_query(
    source_id: int, body: QueryRequest, session: SessionDep, settings: SettingsDep, store: StoreDep
) -> QueryResponse:
    source = get_source(session, source_id)
    sources = sources_in(session, body.sql, [source])
    return query_rows(tables_of(settings, store, sources), body.sql, aliases_for([source]))


@router.post("/query")
def any_query(body: QueryRequest, session: SessionDep, settings: SettingsDep, store: StoreDep) -> QueryResponse:
    sources = sources_in(session, body.sql)
    return query_rows(tables_of(settings, store, sources), body.sql)


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
    source = get_source(session, body.source_id) if body.source_id is not None else None
    if source is None and body.sql is None:
        raise ConflictError("pick a source, or write SQL over the sources")
    dataset = add_dataset(session, settings, store, body.name, source)
    mapping = MappingUpdate(
        source_id=body.source_id, input_column=body.input_column, label_column=body.label_column, sql=body.sql
    )
    if mapping.sql is not None or (mapping.input_column and mapping.label_column):
        apply_mapping(session, settings, store, dataset, mapping)
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
    apply_mapping(session, settings, store, dataset, body)
    session.commit()
    return dataset_summary(settings, store, dataset)


@router.get("/datasets/{slug}/preview")
def dataset_preview(slug: str, session: SessionDep, settings: SettingsDep, store: StoreDep) -> PreviewResponse:
    return dataset_preview_of(settings, store, get_dataset(session, slug))


@router.post("/datasets/{slug}/query")
def dataset_query(
    slug: str, body: QueryRequest, session: SessionDep, settings: SettingsDep, store: StoreDep
) -> QueryResponse:
    dataset = get_dataset(session, slug)
    sources = sources_in(session, body.sql, dataset.sources)
    return query_rows(tables_of(settings, store, sources), body.sql, aliases_for(dataset.sources))


@router.delete("/datasets/{slug}", status_code=204)
def delete_dataset(slug: str, session: SessionDep) -> None:
    dataset = get_dataset(session, slug)
    if dataset.minibrains:
        names = ", ".join(minibrain.name for minibrain in dataset.minibrains)
        raise ConflictError(f"{dataset.name} is used by {names}; pick another dataset for them first")
    session.delete(dataset)
    session.commit()
