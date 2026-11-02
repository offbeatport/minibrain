import shutil
from pathlib import Path
from typing import BinaryIO

from fastapi import APIRouter, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.api.deps import SessionDep, SettingsDep, StoreDep
from minibrain.api.policies import LOCAL_USER
from minibrain.api.schemas import (
    ChatMessage,
    DeployRequest,
    ExampleInfo,
    JobInfo,
    MappingUpdate,
    MinibrainCreate,
    MinibrainDetail,
    MinibrainSummary,
    ModelUpdate,
    PreviewResponse,
    PreviewRow,
    QualityInfo,
    QueryRequest,
    QueryResponse,
)
from minibrain.api.views import detail, job_info, staging_path, summary
from minibrain.artifacts import ArtifactStore, Packing
from minibrain.base_models import DEFAULT_BASE_MODEL
from minibrain.data import quality, snapshot
from minibrain.data.sources import describe, labelled_rows, mapping_sql, run_query, safe_filename, stage, to_text
from minibrain.jobs.queue import enqueue
from minibrain.jobs.specs import prepare_params
from minibrain.models.registry import trainable_bases
from minibrain.registry.files import ArtifactKind, register, snapshot_dir
from minibrain.registry.models import ACTIVE_JOB_STATUSES, AuditEvent, JobKind, Minibrain, now
from minibrain.registry.service import (
    ConflictError,
    create_minibrain,
    get_minibrain,
    latest_snapshot,
    list_minibrains,
    slugify,
)
from minibrain.settings import Settings, sample_file
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
    base = body.base_model or DEFAULT_BASE_MODEL
    if base not in trainable_bases(session):
        raise ConflictError(f"{base} is not a trainable base model on this install")
    minibrain = create_minibrain(session, body.name, "classify", base)
    minibrain.description = body.description.strip()
    minibrain.tags = sorted({tag.strip() for tag in body.tags if tag.strip()})
    session.commit()
    return detail(settings, minibrain)


@router.get("/bases")
def bases(session: SessionDep) -> list[str]:
    return trainable_bases(session)


@router.patch("/{slug}")
def update(slug: str, body: ModelUpdate, session: SessionDep, settings: SettingsDep) -> MinibrainDetail:
    minibrain = get_minibrain(session, slug)
    if body.name is not None:
        minibrain.name = body.name.strip()
    if body.description is not None:
        minibrain.description = body.description.strip()
    if body.tags is not None:
        minibrain.tags = sorted({tag.strip() for tag in body.tags if tag.strip()})
    if body.archived is not None:
        minibrain.archived_at = now() if body.archived else None
    minibrain.updated_at = now()
    session.commit()
    return detail(settings, minibrain)


@router.get("/{slug}")
def read(slug: str, session: SessionDep, settings: SettingsDep) -> MinibrainDetail:
    return detail(settings, get_minibrain(session, slug))


@router.delete("/{slug}", status_code=204)
def delete(slug: str, session: SessionDep, settings: SettingsDep) -> None:
    minibrain = get_minibrain(session, slug)
    if any(job.status in ACTIVE_JOB_STATUSES for job in minibrain.jobs):
        raise ConflictError("cancel the running jobs first")
    session.add(
        AuditEvent(
            actor=LOCAL_USER,
            action="model.delete",
            target=minibrain.slug,
            detail={"name": minibrain.name, "kind": "custom", "versions": len(minibrain.versions)},
        )
    )
    session.delete(minibrain)
    session.commit()
    shutil.rmtree(settings.minibrain_dir(slug), ignore_errors=True)


SAMPLE_NAME = "Travel intents (sample)"
SAMPLE_FILE = "travel_intents.jsonl"
SAMPLE_DESCRIPTION = "Sample: sort travel support messages into intents such as lost luggage or refunds."


def attach_source(
    session: Session, settings: Settings, store: ArtifactStore, minibrain: Minibrain, filename: str, stream: BinaryIO
) -> None:
    stored = store.put_stream(stream)
    artifact = register(session, stored.id, ArtifactKind.SOURCE, Packing.FILE, filename, stored.size)
    staging = staging_path(settings, minibrain)
    staging.parent.mkdir(parents=True, exist_ok=True)
    stage(store.materialize(artifact.id, Packing.FILE, filename), staging)
    minibrain.source_artifact_id = artifact.id
    columns = [column.name for column in describe(staging)[0]]
    input_column, label_column = guess(columns, INPUT_NAMES), guess(columns, LABEL_NAMES)
    minibrain.source_file = filename
    minibrain.input_column = input_column
    minibrain.label_column = label_column
    minibrain.sql = mapping_sql(input_column, label_column) if input_column and label_column else None


@router.post("/{slug}/deploy")
def deploy(slug: str, body: DeployRequest, session: SessionDep, settings: SettingsDep) -> MinibrainDetail:
    minibrain = get_minibrain(session, slug)
    minibrain.deployed = body.deployed
    minibrain.updated_at = now()
    session.commit()
    return detail(settings, minibrain)


@router.post("/{slug}/source")
def upload_source(
    slug: str, file: UploadFile, session: SessionDep, settings: SettingsDep, store: StoreDep
) -> MinibrainDetail:
    minibrain = get_minibrain(session, slug)
    attach_source(session, settings, store, minibrain, safe_filename(file.filename or ""), file.file)
    session.commit()
    return detail(settings, minibrain)


def free_name(session: Session, name: str) -> str:
    taken = set(session.scalars(select(Minibrain.slug)))
    candidates = (name if number == 1 else f"{name} {number}" for number in range(1, 1000))
    return next(candidate for candidate in candidates if slugify(candidate) not in taken)


@router.post("/sample", status_code=201)
def create_sample(session: SessionDep, settings: SettingsDep, store: StoreDep) -> MinibrainDetail:
    minibrain = create_minibrain(session, free_name(session, SAMPLE_NAME), "classify", DEFAULT_BASE_MODEL)
    minibrain.description = SAMPLE_DESCRIPTION
    with sample_file(SAMPLE_FILE).open("rb") as stream:
        attach_source(session, settings, store, minibrain, SAMPLE_FILE, stream)
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


@router.post("/{slug}/snapshots", status_code=202)
def build_snapshot(slug: str, session: SessionDep) -> JobInfo:
    minibrain = get_minibrain(session, slug)
    params = prepare_params(session, minibrain, saved_sql(minibrain))
    job = enqueue(
        session, JobKind.PREPARE, params, minibrain_id=minibrain.id, idempotency_key=f"prepare:{minibrain.id}"
    )
    session.commit()
    return job_info(job)


@router.get("/{slug}/golden")
def golden(slug: str, session: SessionDep, store: StoreDep) -> list[ExampleInfo]:
    current = latest_snapshot(get_minibrain(session, slug))
    if current is None:
        return []
    examples = snapshot.read_split(snapshot_dir(session, store, current), "golden")
    return [ExampleInfo(input=example.input, label=example.label) for example in examples]
