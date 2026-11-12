from collections.abc import Sequence
from dataclasses import asdict
from functools import lru_cache
from typing import Any, cast

from fastapi import APIRouter, Depends, Response, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session, object_session

from minibrain import provision
from minibrain.api.access import admin, builder
from minibrain.api.deps import SessionDep, SettingsDep, StoreDep
from minibrain.api.schemas import (
    CatalogueUpdate,
    ChangeInfo,
    ChatMessage,
    CheckName,
    ColumnInfo,
    ColumnStats,
    DatasetCreate,
    DatasetSummary,
    DataSettings,
    DataSettingsUpdate,
    DatasetVersionDiff,
    DatasetVersionInfo,
    DeltaSourceCreate,
    DiffRow,
    DismissRequest,
    FolderCreate,
    FolderRoots,
    LabelCount,
    LabelShiftInfo,
    MappingUpdate,
    NameTakenInfo,
    PreviewResponse,
    PreviewRow,
    QualityInfo,
    QueryRequest,
    QueryResponse,
    RelabelInfo,
    SampleInfo,
    SourceAdded,
    SourceKind,
    SourceRef,
    SourceStats,
    SourceSummary,
)
from minibrain.api.views import change_info, dataset_version_info, mapping_info
from minibrain.artifacts import ArtifactStore
from minibrain.auth.identity import current_actor
from minibrain.connections.spec import ConnectionProblem
from minibrain.data.dataset_folders import folder_or_root, require_free_dataset_name
from minibrain.data.dataset_versions import (
    changes_since,
    cleanup,
    latest_of,
    take_version,
    version_if_mapped,
    versions_of,
)
from minibrain.data.delta import DELTA
from minibrain.data.diff import compare
from minibrain.data.feedback import example_counts
from minibrain.data.folders import allowed_roots
from minibrain.data.limits import DataLimits, load_limits, save_limits
from minibrain.data.remote import REMOTE_KINDS
from minibrain.data.samples import SAMPLES, add_sample
from minibrain.data.shared import (
    FOLDER,
    Added,
    NameTaken,
    Outcome,
    add_dataset,
    add_delta,
    add_folder,
    add_source,
    aliases_for,
    dataset_sql,
    dataset_tables,
    delta_of,
    folder_scan,
    get_dataset,
    get_source,
    release_upload,
    remote_state,
    require_free_source_name,
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
    example_rows,
    label_counts,
    output_columns,
    require_mapping,
    run_query,
    safe_filename,
    summarize,
    to_text,
)
from minibrain.data.templates import Template, pair_template, template_sql
from minibrain.policy import PolicyError, locked_sources
from minibrain.registry.files import dataset_version_location
from minibrain.registry.models import AuditEvent, Dataset, DatasetVersion, Source, now
from minibrain.registry.service import ConflictError, NotFoundError
from minibrain.settings import Settings
from minibrain.tags import merged_tags
from minibrain.tasks.examples import turns_of

router = APIRouter(prefix="/api")

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


def source_kind(source: Source) -> SourceKind:
    if source.kind in REMOTE_KINDS or source.kind == DELTA:
        return cast(SourceKind, source.kind)
    return "folder" if source.kind == FOLDER else "upload"


def source_ref(source: Source) -> SourceRef:
    return SourceRef(id=source.id, name=source.name, table=source.table_name, kind=source_kind(source))


def folder_fields(source: Source) -> dict[str, Any]:
    if source.kind != FOLDER:
        return {}
    try:
        found = folder_scan(source)
    except SourceError as error:
        return {"path": source.path, "format": source.format, "error": str(error)}
    return {
        "path": source.path,
        "format": source.format,
        "files": len(found.files),
        "modified_at": found.modified_at,
        "size": found.size,
    }


def delta_fields(source: Source) -> dict[str, Any]:
    if source.kind != DELTA:
        return {}
    try:
        state = delta_of(source)
    except (SourceError, PolicyError) as error:
        return {"path": source.path, "error": str(error)}
    return {
        "path": source.path,
        "modified_at": state.modified_at,
        "fingerprint": state.fingerprint,
        "fingerprint_detail": state.detail,
    }


def remote_fields(settings: Settings, source: Source) -> dict[str, Any]:
    if source.kind not in REMOTE_KINDS:
        return {}
    connection = source.connection
    fields: dict[str, Any] = {
        "path": source.path,
        "format": source.format,
        "query": source.query,
        "change_column": source.change_column,
        "connection_id": source.connection_id,
        "connection": connection.name if connection is not None else None,
    }
    try:
        state = remote_state(settings, source)
    except (SourceError, ConnectionProblem, PolicyError) as error:
        return fields | {"error": str(error)}
    return fields | {
        "files": state.files,
        "size": state.size or source.size,
        "modified_at": state.modified_at,
        "fingerprint": state.fingerprint,
        "fingerprint_detail": state.detail,
    }


def source_summary(settings: Settings, store: ArtifactStore, source: Source) -> SourceSummary:
    fields: dict[str, Any] = (
        {"size": source.size} | folder_fields(source) | delta_fields(source) | remote_fields(settings, source)
    )
    columns: tuple[ColumnInfo, ...] = ()
    rows: int | None = None
    if not fields.get("error"):
        try:
            columns, rows = cached_describe(table_of(settings, store, source))
        except (SourceError, ConnectionProblem, PolicyError) as error:
            fields["error"] = str(error)
    return SourceSummary(
        id=source.id,
        kind=source_kind(source),
        name=source.name,
        filename=source.filename,
        table=source.table_name,
        description=source.description or "",
        tags=source.tags or [],
        rows=rows,
        columns=list(columns),
        datasets=[dataset.slug for dataset in source.datasets],
        created_at=source.created_at,
        **fields,
    )


def dataset_changes(settings: Settings, dataset: Dataset, latest: DatasetVersion | None) -> ChangeInfo | None:
    try:
        return change_info(changes_since(settings, dataset, latest))
    except SourceError:
        return None


def known_splits(latest: DatasetVersion | None, changed: ChangeInfo | None) -> dict[str, int] | None:
    if latest is None or not latest.counts or changed is None or changed.data or changed.query:
        return None
    return dict(latest.counts)


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
    columns_mode = bool(dataset.template) or not dataset.sql
    latest = latest_of(dataset)
    changed = dataset_changes(settings, dataset, latest)
    session = object_session(dataset)
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
        models=[model.slug for model in dataset.models],
        model_names=[model.name for model in dataset.models],
        test_examples=example_counts(session, list(dataset.models)) if session is not None else {},
        splits=known_splits(latest, changed),
        dataset_version=dataset_version_info(latest) if latest is not None else None,
        changed=changed,
        row_limit=load_limits(session).row_limit if session is not None else DataLimits().row_limit,
        folder_id=dataset.folder_id,
        updated_at=dataset.updated_at,
    )


def describe_item(item: Source | Dataset, body: CatalogueUpdate) -> None:
    if body.name is not None:
        item.name = body.name.strip()
    if body.description is not None:
        item.description = body.description.strip() or None
    if body.tags is not None:
        item.tags = merged_tags(item.tags, body.tags) or None


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


def requested_template(body: MappingUpdate) -> Template | None:
    if body.template is not None:
        return dict(body.template)
    if body.input_column and body.label_column:
        return pair_template(body.input_column, body.label_column)
    return None


def apply_mapping(
    session: Session, settings: Settings, store: ArtifactStore, dataset: Dataset, body: MappingUpdate
) -> None:
    template = requested_template(body)
    if body.sql is not None:
        sources = sources_in(session, body.sql, dataset.sources)
        check_mapping(tables_of(settings, store, sources), aliases_for(sources), body.sql)
        dataset.sql = body.sql
        dataset.sources = sources
        dataset.source = sources[0] if len(sources) == 1 else None
        dataset.template = None
    elif template is not None:
        source = column_source(session, dataset, body)
        sql = template_sql(template, source.table_name)
        check_mapping([table_of(settings, store, source)], {}, sql)
        dataset.source = source
        dataset.sources = [source]
        dataset.template = template
        dataset.sql = sql
    else:
        raise ConflictError("send an input column and a label column, a template, or SQL")
    dataset.updated_at = now()


def query_rows(tables: Sequence[Table], sql: str, aliases: dict[str, str] | None = None) -> QueryResponse:
    result = run_query(tables, sql, QUERY_ROWS, aliases, as_text=True)
    return QueryResponse(columns=result.columns, rows=[[to_text(value) for value in row] for row in result.rows])


def chat_example(messages: str | None, expected: str | None) -> list[ChatMessage]:
    turns = turns_of(messages) or ()
    found = [ChatMessage(role=turn.role, content=turn.content) for turn in turns]
    return [*found, ChatMessage(role="assistant", content=expected)] if found and expected else found


def preview_of(tables: Sequence[Table], aliases: dict[str, str], sql: str) -> PreviewResponse:
    quality = assess(tables, sql, aliases)
    rows = example_rows(tables, sql, aliases, PREVIEW_ROWS)
    counts = label_counts(tables, sql, LABEL_COUNTS, aliases)
    first = next(((messages, expected) for messages, text, expected in rows if text and expected), (None, None))
    return PreviewResponse(
        rows=[PreviewRow(input=text, label=expected) for _, text, expected in rows],
        quality=QualityInfo.model_validate(quality, from_attributes=True),
        labels=sorted(label for label, _ in counts),
        label_counts=[LabelCount(label=label, rows=size) for label, size in counts],
        example=chat_example(*first),
    )


def dataset_preview_of(settings: Settings, store: ArtifactStore, dataset: Dataset) -> PreviewResponse:
    tables, aliases = dataset_tables(settings, store, dataset)
    return preview_of(tables, aliases, dataset_sql(dataset))


@router.get("/sources", dependencies=[Depends(builder)], summary="List sources")
def list_sources(session: SessionDep, settings: SettingsDep, store: StoreDep) -> list[SourceSummary]:
    found = session.scalars(select(Source).order_by(Source.id.desc()))
    return [source_summary(settings, store, source) for source in found]


ADDED_RESPONSES: dict[int | str, dict[str, Any]] = {
    200: {"model": SourceAdded, "description": "Already added, so nothing new was stored; or replaced"},
    409: {"model": NameTakenInfo, "description": "The name is taken"},
}


def added_source(
    session: Session, settings: Settings, store: ArtifactStore, added: Added, response: Response
) -> SourceAdded:
    session.commit()
    if added.outcome != Outcome.CREATED:
        response.status_code = 200
    summary = source_summary(settings, store, added.source)
    return SourceAdded(**summary.model_dump(), outcome=added.outcome.value)


@router.post(
    "/sources",
    status_code=201,
    responses=ADDED_RESPONSES,
    dependencies=[Depends(builder)],
    summary="Upload a file as a source",
)
def upload_source(
    file: UploadFile,
    response: Response,
    session: SessionDep,
    settings: SettingsDep,
    store: StoreDep,
    name_taken: NameTaken = NameTaken.KEEP_BOTH,
) -> SourceAdded:
    added = add_source(session, store, safe_filename(file.filename or ""), file.file, name_taken)
    return added_source(session, settings, store, added, response)


@router.get("/data/folders", dependencies=[Depends(builder)], summary="List server folders for sources")
def folder_roots(session: SessionDep) -> FolderRoots:
    return FolderRoots(roots=[str(root) for root in allowed_roots(session)], locked="data_folders" in locked_sources())


@router.post(
    "/sources/folders",
    status_code=201,
    responses=ADDED_RESPONSES,
    dependencies=[Depends(builder)],
    summary="Add a server folder source",
)
def add_folder_source(
    body: FolderCreate, response: Response, session: SessionDep, settings: SettingsDep, store: StoreDep
) -> SourceAdded:
    added = add_folder(session, body.path, body.name, body.format)
    return added_source(session, settings, store, added, response)


@router.post(
    "/sources/delta",
    status_code=201,
    responses=ADDED_RESPONSES,
    dependencies=[Depends(builder)],
    summary="Add a Delta table source",
)
def add_delta_source(
    body: DeltaSourceCreate, response: Response, session: SessionDep, settings: SettingsDep, store: StoreDep
) -> SourceAdded:
    added = add_delta(session, body.path, body.name)
    return added_source(session, settings, store, added, response)


@router.get("/samples", dependencies=[Depends(builder)], summary="List sample files")
def list_samples() -> list[SampleInfo]:
    return [SampleInfo(**vars(sample)) for sample in SAMPLES]


@router.post(
    "/samples/{file}",
    status_code=201,
    responses=ADDED_RESPONSES,
    dependencies=[Depends(builder)],
    summary="Add a sample file as a source",
)
def add_sample_source(
    file: str,
    response: Response,
    session: SessionDep,
    settings: SettingsDep,
    store: StoreDep,
    name_taken: NameTaken = NameTaken.KEEP_BOTH,
) -> SourceAdded:
    added = add_sample(session, store, file, name_taken)
    return added_source(session, settings, store, added, response)


@router.get("/sources/{source_id}", dependencies=[Depends(builder)], summary="Read a source")
def read_source(source_id: int, session: SessionDep, settings: SettingsDep, store: StoreDep) -> SourceSummary:
    return source_summary(settings, store, get_source(session, source_id))


@router.patch(
    "/sources/{source_id}",
    responses={409: {"model": NameTakenInfo}},
    dependencies=[Depends(builder)],
    summary="Change a source",
)
def update_source(
    source_id: int, body: CatalogueUpdate, session: SessionDep, settings: SettingsDep, store: StoreDep
) -> SourceSummary:
    source = get_source(session, source_id)
    if body.name is not None:
        require_free_source_name(session, body.name, keep=source)
    describe_item(source, body)
    session.commit()
    return source_summary(settings, store, source)


@router.get("/sources/{source_id}/rows", dependencies=[Depends(builder)], summary="Read a source's rows")
def source_rows(source_id: int, session: SessionDep, settings: SettingsDep, store: StoreDep) -> QueryResponse:
    source = get_source(session, source_id)
    return query_rows([table_of(settings, store, source)], SOURCE_ROWS, aliases_for([source]))


@router.get("/sources/{source_id}/stats", dependencies=[Depends(builder)], summary="Read a source's column statistics")
def source_stats(source_id: int, session: SessionDep, settings: SettingsDep, store: StoreDep) -> SourceStats:
    table = table_of(settings, store, get_source(session, source_id))
    summaries, sampled = summarize(table, STATS_SAMPLE)
    return SourceStats(
        rows=cached_describe(table)[1],
        sampled=sampled,
        columns=[ColumnStats.model_validate(summary, from_attributes=True) for summary in summaries],
    )


@router.post("/sources/{source_id}/query", dependencies=[Depends(builder)], summary="Run SQL over a source")
def source_query(
    source_id: int, body: QueryRequest, session: SessionDep, settings: SettingsDep, store: StoreDep
) -> QueryResponse:
    source = get_source(session, source_id)
    sources = sources_in(session, body.sql, [source])
    return query_rows(tables_of(settings, store, sources), body.sql, aliases_for([source]))


@router.post("/query", dependencies=[Depends(builder)], summary="Run SQL over any sources")
def any_query(body: QueryRequest, session: SessionDep, settings: SettingsDep, store: StoreDep) -> QueryResponse:
    sources = sources_in(session, body.sql)
    return query_rows(tables_of(settings, store, sources), body.sql)


@router.delete("/sources/{source_id}", status_code=204, dependencies=[Depends(builder)], summary="Delete a source")
def delete_source(source_id: int, session: SessionDep, store: StoreDep) -> None:
    source = get_source(session, source_id)
    if source.datasets:
        names = ", ".join(dataset.name for dataset in source.datasets)
        raise ConflictError(f"{source.name} is used by {names}; delete those datasets first")
    artifact_id, filename = source.artifact_id, source.filename
    session.delete(source)
    release_upload(session, store, artifact_id, filename)
    session.commit()


@router.get("/datasets", dependencies=[Depends(builder)], summary="List datasets")
def list_datasets(session: SessionDep, settings: SettingsDep, store: StoreDep) -> list[DatasetSummary]:
    found = session.scalars(select(Dataset).order_by(Dataset.name))
    return [dataset_summary(settings, store, dataset) for dataset in found]


@router.post(
    "/datasets",
    status_code=201,
    responses={409: {"model": NameTakenInfo}},
    dependencies=[Depends(builder)],
    summary="Create a dataset",
)
def create_dataset(body: DatasetCreate, session: SessionDep, settings: SettingsDep, store: StoreDep) -> DatasetSummary:
    source = get_source(session, body.source_id) if body.source_id is not None else None
    if source is None and body.sql is None:
        raise ConflictError("pick a source, or write SQL over the sources")
    folder = folder_or_root(session, body.folder_id)
    require_free_dataset_name(session, body.name, folder)
    dataset = add_dataset(session, settings, store, body.name, source, folder)
    mapping = MappingUpdate(
        source_id=body.source_id,
        input_column=body.input_column,
        label_column=body.label_column,
        template=body.template,
        sql=body.sql,
    )
    if mapping.sql is not None or requested_template(mapping) is not None:
        apply_mapping(session, settings, store, dataset, mapping)
    version_if_mapped(session, settings, dataset)
    session.commit()
    return dataset_summary(settings, store, dataset)


@router.get("/datasets/{slug}", dependencies=[Depends(builder)], summary="Read a dataset")
def read_dataset(slug: str, session: SessionDep, settings: SettingsDep, store: StoreDep) -> DatasetSummary:
    return dataset_summary(settings, store, get_dataset(session, slug))


@router.patch(
    "/datasets/{slug}",
    responses={409: {"model": NameTakenInfo}},
    dependencies=[Depends(builder)],
    summary="Rename or describe a dataset",
)
def update_dataset(
    slug: str, body: CatalogueUpdate, session: SessionDep, settings: SettingsDep, store: StoreDep
) -> DatasetSummary:
    dataset = get_dataset(session, slug)
    if body.name is not None:
        require_free_dataset_name(session, body.name, folder_or_root(session, dataset.folder_id), keep=dataset)
    describe_item(dataset, body)
    session.commit()
    return dataset_summary(settings, store, dataset)


@router.put("/datasets/{slug}/mapping", dependencies=[Depends(builder)], summary="Change a dataset's mapping")
def update_dataset_mapping(
    slug: str, body: MappingUpdate, session: SessionDep, settings: SettingsDep, store: StoreDep
) -> DatasetSummary:
    dataset = get_dataset(session, slug)
    apply_mapping(session, settings, store, dataset, body)
    take_version(session, settings, dataset)
    cleanup(session, settings)
    session.commit()
    return dataset_summary(settings, store, dataset)


@router.get("/datasets/{slug}/preview", dependencies=[Depends(builder)], summary="Preview a dataset's rows")
def dataset_preview(slug: str, session: SessionDep, settings: SettingsDep, store: StoreDep) -> PreviewResponse:
    return dataset_preview_of(settings, store, get_dataset(session, slug))


@router.post("/datasets/{slug}/query", dependencies=[Depends(builder)], summary="Run SQL over a dataset's sources")
def dataset_query(
    slug: str, body: QueryRequest, session: SessionDep, settings: SettingsDep, store: StoreDep
) -> QueryResponse:
    dataset = get_dataset(session, slug)
    sources = sources_in(session, body.sql, dataset.sources)
    return query_rows(tables_of(settings, store, sources), body.sql, aliases_for(dataset.sources))


@router.delete("/datasets/{slug}", status_code=204, dependencies=[Depends(builder)], summary="Delete a dataset")
def delete_dataset(slug: str, session: SessionDep, settings: SettingsDep) -> None:
    dataset = get_dataset(session, slug)
    released = sorted(model.slug for model in dataset.models)
    for model in list(dataset.models):
        model.dataset_id = None
    for dataset_version in dataset.versions:
        dataset_version.dataset = None
    session.add(
        AuditEvent(
            actor=current_actor(),
            action="dataset.delete",
            target=f"dataset:{dataset.slug}",
            detail={"name": dataset.name, "models": released},
        )
    )
    session.delete(dataset)
    session.flush()
    cleanup(session, settings)
    session.commit()


@router.get("/datasets/{slug}/versions", dependencies=[Depends(builder)], summary="List a dataset's versions")
def list_dataset_versions(slug: str, session: SessionDep) -> list[DatasetVersionInfo]:
    return [dataset_version_info(dataset_version) for dataset_version in versions_of(get_dataset(session, slug))]


@router.post(
    "/datasets/{slug}/versions", status_code=201, dependencies=[Depends(builder)], summary="Save a dataset version"
)
def save_dataset_version(slug: str, session: SessionDep, settings: SettingsDep) -> DatasetVersionInfo:
    dataset_version = take_version(session, settings, get_dataset(session, slug))
    cleanup(session, settings)
    session.commit()
    return dataset_version_info(dataset_version)


def get_dataset_version(session: Session, dataset_version_id: int) -> DatasetVersion:
    found = session.get(DatasetVersion, dataset_version_id)
    if found is None:
        raise NotFoundError(f"no dataset version {dataset_version_id}")
    return found


@router.get(
    "/dataset-versions/{dataset_version_id}/diff/{other_id}",
    dependencies=[Depends(builder)],
    summary="Compare two dataset versions",
)
def diff_dataset_versions(
    dataset_version_id: int, other_id: int, session: SessionDep, store: StoreDep
) -> DatasetVersionDiff:
    before, after = get_dataset_version(session, dataset_version_id), get_dataset_version(session, other_id)
    found = compare(dataset_version_location(session, store, before), dataset_version_location(session, store, after))
    return DatasetVersionDiff(
        before=dataset_version_info(before),
        after=dataset_version_info(after),
        added=found.added,
        removed=found.removed,
        relabelled=found.relabelled,
        unchanged=found.unchanged,
        labels=[LabelShiftInfo(label=item.label, before=item.before, after=item.after) for item in found.labels],
        added_rows=[DiffRow(input=text, label=label) for text, label in found.added_rows],
        removed_rows=[DiffRow(input=text, label=label) for text, label in found.removed_rows],
        relabelled_rows=[
            RelabelInfo(input=item.input, before=item.before, after=item.after) for item in found.relabelled_rows
        ],
    )


def data_settings(limits: DataLimits) -> DataSettings:
    locked = provision.provided("data").sources
    return DataSettings.model_validate(asdict(limits) | {"checks_off": list(limits.checks_off), "locked": locked})


@router.put(
    "/datasets/{slug}/checks/{check}/dismissal",
    status_code=204,
    dependencies=[Depends(builder)],
    summary="Dismiss a data check",
)
def dismiss_check(slug: str, check: CheckName, body: DismissRequest, session: SessionDep) -> None:
    dataset = get_dataset(session, slug)
    dataset.dismissed = (dataset.dismissed or {}) | {check: body.signature}
    session.commit()


@router.delete(
    "/datasets/{slug}/checks/{check}/dismissal",
    status_code=204,
    dependencies=[Depends(builder)],
    summary="Restore a dismissed data check",
)
def restore_check(slug: str, check: CheckName, session: SessionDep) -> None:
    dataset = get_dataset(session, slug)
    dataset.dismissed = {name: value for name, value in (dataset.dismissed or {}).items() if name != check} or None
    session.commit()


@router.get("/settings/data", dependencies=[Depends(builder)], summary="Read data settings")
def read_data_settings(session: SessionDep) -> DataSettings:
    return data_settings(load_limits(session))


@router.put("/settings/data", dependencies=[Depends(admin)], summary="Change data settings")
def update_data_settings(body: DataSettingsUpdate, session: SessionDep, settings: SettingsDep) -> DataSettings:
    limits = save_limits(session, body.model_dump(exclude_none=True))
    cleanup(session, settings)
    session.commit()
    return data_settings(limits)
