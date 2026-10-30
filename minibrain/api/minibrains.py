import shutil
from pathlib import Path

from fastapi import APIRouter, UploadFile

from minibrain.api.deps import SessionDep, SettingsDep
from minibrain.api.schemas import (
    ChatMessage,
    ExampleInfo,
    MappingUpdate,
    MinibrainCreate,
    MinibrainDetail,
    MinibrainSummary,
    PreviewResponse,
    PreviewRow,
    QualityInfo,
    QueryRequest,
    QueryResponse,
    SnapshotInfo,
)
from minibrain.api.views import detail, snapshot_info, staging_path, summary
from minibrain.base_models import DEFAULT_BASE_MODEL
from minibrain.data import quality, snapshot
from minibrain.data.sources import describe, labelled_rows, mapping_sql, run_query, safe_filename, stage, to_text
from minibrain.registry.models import ACTIVE_JOB_STATUSES, Minibrain, Snapshot
from minibrain.registry.service import ConflictError, create_minibrain, get_minibrain, latest_snapshot, list_minibrains
from minibrain.settings import Settings
from minibrain.tasks.classify import trained_messages

router = APIRouter(prefix="/api/minibrains", tags=["minibrains"])

INPUT_NAMES = ("input", "text", "message", "question", "query", "prompt", "utterance", "body", "content")
LABEL_NAMES = ("label", "category", "intent", "class", "target", "topic", "tag")
PREVIEW_ROWS = 20
QUERY_ROWS = 50


def guess(columns: list[str], names: tuple[str, ...]) -> str | None:
    lowered = {column.lower(): column for column in columns}
    return next((lowered[name] for name in names if name in lowered), None)


def saved_sql(minibrain: Minibrain) -> str:
    if not minibrain.sql:
        raise ConflictError("map an input column and a label column first")
    return minibrain.sql


def require_source(settings: Settings, minibrain: Minibrain) -> Path:
    staging = staging_path(settings, minibrain)
    if not staging.exists():
        raise ConflictError("upload a data file first")
    return staging


@router.get("")
def list_all(session: SessionDep) -> list[MinibrainSummary]:
    return [summary(minibrain) for minibrain in list_minibrains(session)]


@router.post("", status_code=201)
def create(body: MinibrainCreate, session: SessionDep, settings: SettingsDep) -> MinibrainDetail:
    return detail(settings, create_minibrain(session, body.name, "classify", DEFAULT_BASE_MODEL))


@router.get("/{slug}")
def read(slug: str, session: SessionDep, settings: SettingsDep) -> MinibrainDetail:
    return detail(settings, get_minibrain(session, slug))


@router.delete("/{slug}", status_code=204)
def delete(slug: str, session: SessionDep, settings: SettingsDep) -> None:
    minibrain = get_minibrain(session, slug)
    if any(job.status in ACTIVE_JOB_STATUSES for job in minibrain.jobs):
        raise ConflictError("cancel the running jobs first")
    for job in minibrain.jobs:
        Path(job.log_path).unlink(missing_ok=True)
    session.delete(minibrain)
    session.commit()
    shutil.rmtree(settings.minibrain_dir(slug), ignore_errors=True)


@router.post("/{slug}/source")
def upload_source(slug: str, file: UploadFile, session: SessionDep, settings: SettingsDep) -> MinibrainDetail:
    minibrain = get_minibrain(session, slug)
    filename = safe_filename(file.filename or "")
    source_dir = settings.minibrain_dir(slug) / "source"
    shutil.rmtree(source_dir, ignore_errors=True)
    source_dir.mkdir(parents=True)
    path = source_dir / filename
    with path.open("wb") as destination:
        shutil.copyfileobj(file.file, destination)
    staging = staging_path(settings, minibrain)
    stage(path, staging)
    columns = [column.name for column in describe(staging)[0]]
    input_column, label_column = guess(columns, INPUT_NAMES), guess(columns, LABEL_NAMES)
    minibrain.source_file = filename
    minibrain.input_column = input_column
    minibrain.label_column = label_column
    minibrain.sql = mapping_sql(input_column, label_column) if input_column and label_column else None
    session.commit()
    return detail(settings, minibrain)


@router.put("/{slug}/mapping")
def update_mapping(slug: str, body: MappingUpdate, session: SessionDep, settings: SettingsDep) -> MinibrainDetail:
    minibrain = get_minibrain(session, slug)
    staging = require_source(settings, minibrain)
    if body.sql is not None:
        run_query(staging, body.sql, 1)
        minibrain.sql = body.sql
        minibrain.input_column = None
        minibrain.label_column = None
    elif body.input_column and body.label_column:
        sql = mapping_sql(body.input_column, body.label_column)
        run_query(staging, sql, 1)
        minibrain.input_column = body.input_column
        minibrain.label_column = body.label_column
        minibrain.sql = sql
    else:
        raise ConflictError("send an input column and a label column, or SQL")
    session.commit()
    return detail(settings, minibrain)


@router.post("/{slug}/query")
def query(slug: str, body: QueryRequest, session: SessionDep, settings: SettingsDep) -> QueryResponse:
    minibrain = get_minibrain(session, slug)
    result = run_query(require_source(settings, minibrain), body.sql, QUERY_ROWS)
    return QueryResponse(columns=result.columns, rows=[[to_text(value) for value in row] for row in result.rows])


@router.get("/{slug}/preview")
def preview(slug: str, session: SessionDep, settings: SettingsDep) -> PreviewResponse:
    minibrain = get_minibrain(session, slug)
    rows = labelled_rows(require_source(settings, minibrain), saved_sql(minibrain))
    assessed = quality.assess(rows)
    labels = sorted({label.strip() for _, label in rows if label and label.strip()})
    first = next((text for text, label in rows if text and label), "")
    return PreviewResponse(
        rows=[PreviewRow(input=text, label=label) for text, label in rows[:PREVIEW_ROWS]],
        quality=QualityInfo.model_validate(assessed, from_attributes=True),
        labels=labels[:200],
        example=[ChatMessage.model_validate(message) for message in trained_messages(first)],
    )


@router.post("/{slug}/snapshots", status_code=201)
def build_snapshot(slug: str, session: SessionDep, settings: SettingsDep) -> SnapshotInfo:
    minibrain = get_minibrain(session, slug)
    rows = labelled_rows(require_source(settings, minibrain), saved_sql(minibrain))
    files = snapshot.write(snapshot.split(snapshot.clean(rows)), settings.minibrain_dir(slug) / "snapshots")
    current = latest_snapshot(minibrain)
    if current is not None and current.hash == files.hash:
        return snapshot_info(current)
    record = Snapshot(
        minibrain=minibrain, hash=files.hash, directory=str(files.directory), counts=files.counts, labels=files.labels
    )
    session.add(record)
    session.commit()
    return snapshot_info(record)


@router.get("/{slug}/golden")
def golden(slug: str, session: SessionDep) -> list[ExampleInfo]:
    current = latest_snapshot(get_minibrain(session, slug))
    if current is None:
        return []
    examples = snapshot.read_split(Path(current.directory), "golden")
    return [ExampleInfo(input=example.input, label=example.label) for example in examples]
