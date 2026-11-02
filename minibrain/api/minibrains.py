import shutil

from fastapi import APIRouter, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.api.data import apply_mapping, preview_of, query_rows
from minibrain.api.deps import SessionDep, SettingsDep, StoreDep
from minibrain.api.policies import LOCAL_USER
from minibrain.api.schemas import (
    DatasetChoice,
    DeployRequest,
    ExampleInfo,
    JobInfo,
    MappingUpdate,
    MinibrainCreate,
    MinibrainDetail,
    MinibrainSummary,
    ModelUpdate,
    PreviewResponse,
    QueryRequest,
    QueryResponse,
)
from minibrain.api.views import detail, job_info, summary
from minibrain.base_models import DEFAULT_BASE_MODEL
from minibrain.data import snapshot
from minibrain.data.shared import attach_upload, dataset_of, dataset_sql, get_dataset, staging_of
from minibrain.data.sources import safe_filename
from minibrain.jobs.queue import enqueue
from minibrain.jobs.specs import prepare_params
from minibrain.models.registry import trainable_bases
from minibrain.registry.files import snapshot_dir
from minibrain.registry.models import ACTIVE_JOB_STATUSES, AuditEvent, JobKind, Minibrain, now
from minibrain.registry.service import (
    ConflictError,
    create_minibrain,
    drop_orphan_keys,
    get_minibrain,
    latest_snapshot,
    list_minibrains,
    slugify,
)
from minibrain.settings import sample_file

router = APIRouter(prefix="/api/minibrains", tags=["minibrains"])


@router.get("")
def list_all(session: SessionDep) -> list[MinibrainSummary]:
    return [summary(minibrain) for minibrain in list_minibrains(session)]


@router.post("", status_code=201)
def create(body: MinibrainCreate, session: SessionDep, settings: SettingsDep, store: StoreDep) -> MinibrainDetail:
    base = body.base_model or DEFAULT_BASE_MODEL
    if body.task != "classify":
        raise ConflictError(f"{body.task} models are not available yet; only Classify is")
    if base not in trainable_bases(session):
        raise ConflictError(f"{base} is not a trainable base model on this install")
    minibrain = create_minibrain(session, body.name, body.task, base)
    minibrain.description = body.description.strip()
    minibrain.tags = sorted({tag.strip() for tag in body.tags if tag.strip()})
    if body.sample:
        with sample_file(SAMPLE_FILE).open("rb") as stream:
            attach_upload(session, settings, store, minibrain, SAMPLE_FILE, stream)
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
    minibrain.updated_at = now()
    session.commit()
    return detail(settings, minibrain)


@router.get("/{slug}")
def read(slug: str, session: SessionDep, settings: SettingsDep) -> MinibrainDetail:
    return detail(settings, get_minibrain(session, slug))


@router.delete("/{slug}", status_code=204)
def delete(slug: str, session: SessionDep, settings: SettingsDep) -> None:
    minibrain = get_minibrain(session, slug)
    if minibrain.deployed:
        raise ConflictError(f"{minibrain.name} is deployed; undeploy it first")
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
    drop_orphan_keys(session)
    session.commit()
    shutil.rmtree(settings.minibrain_dir(slug), ignore_errors=True)


SAMPLE_NAME = "Travel intents (sample)"
SAMPLE_FILE = "travel_intents.jsonl"
SAMPLE_DESCRIPTION = "Sample: sort travel support messages into intents such as lost luggage or refunds."


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
    attach_upload(session, settings, store, minibrain, safe_filename(file.filename or ""), file.file)
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
        attach_upload(session, settings, store, minibrain, SAMPLE_FILE, stream)
    session.commit()
    return detail(settings, minibrain)


@router.put("/{slug}/dataset")
def choose_dataset(slug: str, body: DatasetChoice, session: SessionDep, settings: SettingsDep) -> MinibrainDetail:
    minibrain = get_minibrain(session, slug)
    minibrain.dataset = get_dataset(session, body.dataset) if body.dataset else None
    minibrain.updated_at = now()
    session.commit()
    return detail(settings, minibrain)


@router.put("/{slug}/mapping")
def update_mapping(
    slug: str, body: MappingUpdate, session: SessionDep, settings: SettingsDep, store: StoreDep
) -> MinibrainDetail:
    minibrain = get_minibrain(session, slug)
    dataset = dataset_of(minibrain)
    apply_mapping(staging_of(settings, store, dataset.source), dataset, body)
    session.commit()
    return detail(settings, minibrain)


@router.post("/{slug}/query")
def query(slug: str, body: QueryRequest, session: SessionDep, settings: SettingsDep, store: StoreDep) -> QueryResponse:
    dataset = dataset_of(get_minibrain(session, slug))
    return query_rows(staging_of(settings, store, dataset.source), body.sql)


@router.get("/{slug}/preview")
def preview(slug: str, session: SessionDep, settings: SettingsDep, store: StoreDep) -> PreviewResponse:
    dataset = dataset_of(get_minibrain(session, slug))
    return preview_of(staging_of(settings, store, dataset.source), dataset_sql(dataset))


@router.post("/{slug}/snapshots", status_code=202)
def build_snapshot(slug: str, session: SessionDep) -> JobInfo:
    minibrain = get_minibrain(session, slug)
    dataset = dataset_of(minibrain)
    params = prepare_params(session, dataset, dataset_sql(dataset))
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
