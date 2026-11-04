import shutil

from fastapi import APIRouter, Depends, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.api.access import builder, sees_rows, viewer
from minibrain.api.data import apply_mapping, dataset_preview_of, query_rows
from minibrain.api.deps import SessionDep, SettingsDep, StoreDep
from minibrain.api.schemas import (
    DatasetChoice,
    DeployRequest,
    ExampleInfo,
    MappingUpdate,
    MinibrainCreate,
    MinibrainDetail,
    MinibrainSummary,
    ModelUpdate,
    PreviewResponse,
    QueryRequest,
    QueryResponse,
    RequestBodiesUpdate,
)
from minibrain.api.views import detail, summary
from minibrain.auth.identity import current_actor
from minibrain.base_models import DEFAULT_BASE_MODEL
from minibrain.data import snapshot
from minibrain.data.shared import (
    aliases_for,
    attach_upload,
    dataset_of,
    get_dataset,
    sources_in,
    tables_of,
)
from minibrain.data.snapshots import cleanup, model_snapshot_now
from minibrain.data.sources import safe_filename
from minibrain.models.registry import available_bases, base_readiness
from minibrain.policy import LockedError, bodies_choice
from minibrain.registry.files import snapshot_location
from minibrain.registry.models import ACTIVE_JOB_STATUSES, AuditEvent, Minibrain, now
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
from minibrain.tags import merged_tags, user_tags

router = APIRouter(prefix="/api/minibrains", tags=["minibrains"])


@router.get("", dependencies=[Depends(viewer)])
def list_all(session: SessionDep) -> list[MinibrainSummary]:
    return [summary(minibrain) for minibrain in list_minibrains(session)]


@router.post("", status_code=201, dependencies=[Depends(builder)])
def create(body: MinibrainCreate, session: SessionDep, settings: SettingsDep, store: StoreDep) -> MinibrainDetail:
    base = body.base_model or DEFAULT_BASE_MODEL
    if body.task != "classify":
        raise ConflictError(f"{body.task} models are not available yet; only Classify is")
    if base_readiness(session, base) == "missing":
        raise ConflictError(f"{base} is not a base model on this install")
    minibrain = create_minibrain(session, body.name, body.task, base)
    minibrain.description = body.description.strip()
    minibrain.tags = user_tags(body.tags)
    if body.sample:
        with sample_file(SAMPLE_FILE).open("rb") as stream:
            attach_upload(session, settings, store, minibrain, SAMPLE_FILE, stream)
    session.commit()
    return detail(settings, minibrain)


@router.get("/bases", dependencies=[Depends(viewer)])
def bases(session: SessionDep) -> list[str]:
    return available_bases(session)


@router.patch("/{slug}", dependencies=[Depends(builder)])
def update(slug: str, body: ModelUpdate, session: SessionDep, settings: SettingsDep) -> MinibrainDetail:
    minibrain = get_minibrain(session, slug)
    if body.name is not None:
        minibrain.name = body.name.strip()
    if body.description is not None:
        minibrain.description = body.description.strip()
    if body.tags is not None:
        minibrain.tags = merged_tags(minibrain.tags, body.tags)
    minibrain.updated_at = now()
    session.commit()
    return detail(settings, minibrain)


@router.get("/{slug}", dependencies=[Depends(viewer)])
def read(slug: str, session: SessionDep, settings: SettingsDep) -> MinibrainDetail:
    found = detail(settings, get_minibrain(session, slug))
    if sees_rows() or found.snapshot is None:
        return found
    checks = [check.model_copy(update={"examples": []}) for check in found.snapshot.checks]
    return found.model_copy(update={"snapshot": found.snapshot.model_copy(update={"checks": checks})})


@router.delete("/{slug}", status_code=204, dependencies=[Depends(builder)])
def delete(slug: str, session: SessionDep, settings: SettingsDep) -> None:
    minibrain = get_minibrain(session, slug)
    if minibrain.deployed:
        raise ConflictError(f"{minibrain.name} is deployed; undeploy it first")
    if any(job.status in ACTIVE_JOB_STATUSES for job in minibrain.jobs):
        raise ConflictError("cancel the running jobs first")
    session.add(
        AuditEvent(
            actor=current_actor(),
            action="model.delete",
            target=minibrain.slug,
            detail={"name": minibrain.name, "kind": "custom", "versions": len(minibrain.versions)},
        )
    )
    session.delete(minibrain)
    drop_orphan_keys(session)
    cleanup(session, settings)
    session.commit()
    shutil.rmtree(settings.minibrain_dir(slug), ignore_errors=True)


SAMPLE_NAME = "Travel intents (sample)"
SAMPLE_FILE = "travel_intents.jsonl"
SAMPLE_DESCRIPTION = "Sample: sort travel support messages into intents such as lost luggage or refunds."


@router.post("/{slug}/deploy", dependencies=[Depends(builder)])
def deploy(slug: str, body: DeployRequest, session: SessionDep, settings: SettingsDep) -> MinibrainDetail:
    minibrain = get_minibrain(session, slug)
    if minibrain.deployed != body.deployed:
        action = "model.deploy" if body.deployed else "model.undeploy"
        facts = {"name": minibrain.name, "version": minibrain.current_version}
        session.add(AuditEvent(actor=current_actor(), action=action, target=minibrain.slug, detail=facts))
    minibrain.deployed = body.deployed
    minibrain.updated_at = now()
    session.commit()
    return detail(settings, minibrain)


LOCKED_BY = {
    "ui": "locked for every model under Settings, Security",
    "config file": "set for every model in minibrain.yaml",
    "environment": "set for every model by the server's environment",
}


@router.put("/{slug}/request-bodies", dependencies=[Depends(builder)])
def keep_request_bodies(
    slug: str, body: RequestBodiesUpdate, session: SessionDep, settings: SettingsDep
) -> MinibrainDetail:
    minibrain = get_minibrain(session, slug)
    _, lock = bodies_choice(session, minibrain.request_bodies)
    if lock is not None:
        raise LockedError(f"Keep request inputs and answers is {LOCKED_BY.get(lock, lock)}")
    if minibrain.request_bodies != body.kept:
        facts = {"name": minibrain.name, "from": minibrain.request_bodies, "to": body.kept}
        session.add(
            AuditEvent(actor=current_actor(), action="model.request_bodies", target=minibrain.slug, detail=facts)
        )
    minibrain.request_bodies = body.kept
    minibrain.updated_at = now()
    session.commit()
    return detail(settings, minibrain)


@router.post("/{slug}/source", dependencies=[Depends(builder)])
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


@router.post("/sample", status_code=201, dependencies=[Depends(builder)])
def create_sample(session: SessionDep, settings: SettingsDep, store: StoreDep) -> MinibrainDetail:
    minibrain = create_minibrain(session, free_name(session, SAMPLE_NAME), "classify", DEFAULT_BASE_MODEL)
    minibrain.description = SAMPLE_DESCRIPTION
    with sample_file(SAMPLE_FILE).open("rb") as stream:
        attach_upload(session, settings, store, minibrain, SAMPLE_FILE, stream)
    session.commit()
    return detail(settings, minibrain)


@router.put("/{slug}/dataset", dependencies=[Depends(builder)])
def choose_dataset(slug: str, body: DatasetChoice, session: SessionDep, settings: SettingsDep) -> MinibrainDetail:
    minibrain = get_minibrain(session, slug)
    minibrain.dataset = get_dataset(session, body.dataset) if body.dataset else None
    minibrain.updated_at = now()
    session.commit()
    return detail(settings, minibrain)


@router.put("/{slug}/mapping", dependencies=[Depends(builder)])
def update_mapping(
    slug: str, body: MappingUpdate, session: SessionDep, settings: SettingsDep, store: StoreDep
) -> MinibrainDetail:
    minibrain = get_minibrain(session, slug)
    apply_mapping(session, settings, store, dataset_of(minibrain), body)
    session.commit()
    return detail(settings, minibrain)


@router.post("/{slug}/query", dependencies=[Depends(builder)])
def query(slug: str, body: QueryRequest, session: SessionDep, settings: SettingsDep, store: StoreDep) -> QueryResponse:
    dataset = dataset_of(get_minibrain(session, slug))
    sources = sources_in(session, body.sql, dataset.sources)
    return query_rows(tables_of(settings, store, sources), body.sql, aliases_for(dataset.sources))


@router.get("/{slug}/preview", dependencies=[Depends(builder)])
def preview(slug: str, session: SessionDep, settings: SettingsDep, store: StoreDep) -> PreviewResponse:
    return dataset_preview_of(settings, store, dataset_of(get_minibrain(session, slug)))


@router.post("/{slug}/snapshots", status_code=201, dependencies=[Depends(builder)])
def build_snapshot(slug: str, session: SessionDep, settings: SettingsDep) -> MinibrainDetail:
    minibrain = get_minibrain(session, slug)
    minibrain.snapshot = model_snapshot_now(session, settings, minibrain, saved=True)
    cleanup(session, settings)
    session.commit()
    return detail(settings, minibrain)


@router.get("/{slug}/golden", dependencies=[Depends(builder)])
def golden(slug: str, session: SessionDep, store: StoreDep) -> list[ExampleInfo]:
    current = latest_snapshot(get_minibrain(session, slug))
    if current is None:
        return []
    examples = snapshot.read_split(snapshot_location(session, store, current), "golden")
    return [ExampleInfo(input=example.input, label=example.label) for example in examples]
