import threading

import httpx
from fastapi import APIRouter, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from minibrain.api.deps import SessionDep, SettingsDep
from minibrain.api.model_rows import base_availability, model_job
from minibrain.api.schemas import (
    AddedInfo,
    CatalogEntry,
    CatalogResponse,
    CatalogVariantInfo,
    DownloadRequest,
    FitInfo,
    HardwareInfo,
    JobInfo,
    ModelRow,
)
from minibrain.api.views import job_info
from minibrain.jobs.queue import enqueue
from minibrain.models import hub
from minibrain.models.catalog import DAILY_SYNC_KEY, catalog_url, daily_sync, sync_params, upsert
from minibrain.models.hardware import Hardware, detect, fit
from minibrain.models.hubadd import HubAddError, lookup, parse_repo
from minibrain.models.registry import start_download
from minibrain.policy import load as load_policy
from minibrain.registry.models import CatalogModel, CatalogVariant, Job, JobKind, JobStatus, Model, now
from minibrain.registry.service import ConflictError, NotFoundError
from minibrain.registry.settings_store import write
from minibrain.settings import Settings

router = APIRouter(prefix="/api/catalog", tags=["catalog"])
DETECT_LOCK = threading.Lock()
LOCAL_USER = "Local user"
SYNC_INTERVAL_SECONDS = 24 * 3600
SCHEDULE_CHECK_SECONDS = 3600.0


def hardware(request: Request) -> Hardware:
    with DETECT_LOCK:
        if getattr(request.app.state, "hardware", None) is None:
            request.app.state.hardware = detect()
        return request.app.state.hardware


def cached_fully(variant: CatalogVariant) -> bool:
    from huggingface_hub import try_to_load_from_cache

    for entry in variant.files:
        found = try_to_load_from_cache(variant.repo, entry["path"], revision=variant.revision)
        if not isinstance(found, str):
            return False
    return True


def added_for(session: Session, settings: Settings, entry: CatalogModel) -> list[AddedInfo]:
    added: list[AddedInfo] = []
    for model in session.scalars(select(Model).where(Model.catalog_id == entry.id)):
        availability = base_availability(model, model_job(session, model.id), settings)
        added.append(AddedInfo(key=model.id, variant_id=model.variant_id, availability=availability, error=model.error))
    return added


def variant_info(variant: CatalogVariant, machine: Hardware) -> CatalogVariantInfo:
    return CatalogVariantInfo(
        id=variant.id,
        label=variant.label,
        format=variant.format,
        precision=variant.precision,
        repo=variant.repo,
        revision=variant.revision,
        latest_revision=variant.latest_revision,
        size_bytes=variant.size_bytes,
        weights_bytes=variant.weights_bytes,
        files=len(variant.files),
        runtimes=list(variant.runtimes),
        requires=dict(variant.requires),
        fit=FitInfo(**fit(variant.weights_bytes, variant.requires, machine)),
    )


def entry_info(session: Session, settings: Settings, entry: CatalogModel, machine: Hardware) -> CatalogEntry:
    return CatalogEntry(
        id=entry.id,
        name=entry.name,
        description=entry.description,
        provider=entry.provider,
        repo=entry.repo,
        capabilities=list(entry.capabilities),
        license=entry.license,
        license_name=entry.license_name,
        license_summary=entry.license_summary,
        license_url=entry.license_url,
        gated=entry.gated,
        recommended=entry.recommended,
        recommendation=entry.recommendation,
        trainable=entry.trainable,
        popularity=entry.popularity,
        family=entry.family,
        generation=entry.generation,
        architecture=entry.architecture,
        tier=entry.tier,
        params_b=entry.params_b,
        moe=entry.moe,
        support=entry.support,
        superseded_by=entry.superseded_by,
        origin=entry.origin,
        variants=[variant_info(variant, machine) for variant in entry.variants],
        added=added_for(session, settings, entry),
    )


def latest_sync(session: Session) -> Job | None:
    query = select(Job).where(Job.kind == JobKind.CATALOG_SYNC).order_by(Job.id.desc()).limit(1)
    return session.scalar(query)


@router.get("")
def catalogue(request: Request, session: SessionDep, settings: SettingsDep) -> CatalogResponse:
    machine = hardware(request)
    policy = load_policy(session)
    entries = session.scalars(select(CatalogModel).order_by(CatalogModel.position))
    synced = [entry.synced_at for entry in session.scalars(select(CatalogModel)) if entry.synced_at is not None]
    sync = latest_sync(session)
    return CatalogResponse(
        entries=[entry_info(session, settings, entry, machine) for entry in entries],
        hardware=HardwareInfo(**machine.as_dict()),
        online=hub.CONNECTIVITY.check() if policy.outbound_allowed(hub.endpoint()) else False,
        offline_forced=hub.offline() or not policy.outbound_allowed(hub.endpoint()),
        endpoint=hub.endpoint(),
        token_configured=hub.token() is not None,
        synced_at=max(synced, default=None),
        sync_job=job_info(sync) if sync is not None else None,
        catalog_url=catalog_url(),
    )


@router.post("/{catalog_id}/download", status_code=202)
def download(
    catalog_id: str, body: DownloadRequest, request: Request, session: SessionDep, settings: SettingsDep
) -> ModelRow:
    from minibrain.api.models import row_of

    entry = session.get(CatalogModel, catalog_id)
    variant = session.get(CatalogVariant, body.variant)
    if entry is None or variant is None or variant.catalog_id != entry.id:
        raise NotFoundError(f"{catalog_id} has no variant {body.variant}")
    if not body.accept_license:
        raise ConflictError(f"Review and accept the {entry.license_name} before downloading {entry.name}")
    local = cached_fully(variant)
    if not local:
        load_policy(session).outbound(hub.endpoint())
    if not local and hub.CONNECTIVITY.check() is False:
        raise ConflictError("Offline: downloads need a connection. Import the model files instead.")
    if not local and entry.gated and hub.token() is None:
        raise ConflictError(
            f"{entry.name} is gated. Accept its licence at {hub.endpoint()}/{variant.repo} "
            "and set HF_TOKEN on the minibrain server, then retry."
        )
    model = start_download(session, settings, entry, variant, LOCAL_USER)
    session.commit()
    return row_of(session, settings, request, model)


class HubAddRequest(BaseModel):
    repo: str


@router.post("/hub", status_code=201)
def add_from_hub(body: HubAddRequest, request: Request, session: SessionDep, settings: SettingsDep) -> CatalogEntry:
    policy = load_policy(session)
    policy.add_from_hub()
    policy.outbound(hub.endpoint())
    try:
        repo = parse_repo(body.repo)
    except HubAddError as error:
        raise ConflictError(str(error)) from error
    existing = session.scalar(select(CatalogModel).where(CatalogModel.repo == repo))
    if existing is not None:
        return entry_info(session, settings, existing, hardware(request))
    try:
        entry = lookup(repo)
    except HubAddError as error:
        raise ConflictError(str(error)) from error
    except httpx.HTTPError as error:
        raise ConflictError(f"Could not reach {hub.endpoint()}: {error}") from error
    upsert(session, entry)
    session.flush()
    added = session.get(CatalogModel, entry["id"])
    if added is None:
        raise NotFoundError(f"{repo} could not be added")
    added.origin = "hub"
    session.commit()
    return entry_info(session, settings, added, hardware(request))


@router.delete("/{catalog_id}", status_code=204)
def remove_from_catalogue(catalog_id: str, session: SessionDep) -> None:
    entry = session.get(CatalogModel, catalog_id)
    if entry is None:
        raise NotFoundError(f"{catalog_id} is not in the catalogue")
    if entry.origin != "hub":
        raise ConflictError("Only models added from Hugging Face can be removed from the catalogue")
    if session.scalar(select(Model.id).where(Model.catalog_id == catalog_id).limit(1)) is not None:
        raise ConflictError(f"{entry.name} is on this install; archive or remove the model first")
    session.delete(entry)
    session.commit()


@router.post("/sync", status_code=202)
def sync(session: SessionDep) -> JobInfo:
    if hub.offline():
        raise ConflictError("Offline: the catalogue sync needs a connection; the bundled catalogue stays in use")
    url = catalog_url()
    if url is None:
        raise ConflictError("Set MINIBRAIN_CATALOG_URL to sync the catalogue; the bundled catalogue stays in use")
    load_policy(session).outbound(url)
    job = enqueue(session, JobKind.CATALOG_SYNC, sync_params(session), idempotency_key="catalog_sync")
    session.commit()
    return job_info(job)


class CatalogSettings(BaseModel):
    daily_sync: bool


@router.get("/settings")
def read_settings(session: SessionDep) -> CatalogSettings:
    return CatalogSettings(daily_sync=daily_sync(session))


@router.put("/settings")
def update_settings(body: CatalogSettings, session: SessionDep) -> CatalogSettings:
    write(session, DAILY_SYNC_KEY, body.daily_sync)
    session.commit()
    return CatalogSettings(daily_sync=body.daily_sync)


def sync_due(session: Session) -> bool:
    url = catalog_url()
    if hub.offline() or url is None or not daily_sync(session) or not load_policy(session).outbound_allowed(url):
        return False
    last = latest_sync(session)
    if last is not None and last.status in (JobStatus.QUEUED, JobStatus.RUNNING):
        return False
    return last is None or (now() - last.created_at).total_seconds() > SYNC_INTERVAL_SECONDS


def schedule_forever(sessions: sessionmaker[Session], stop: threading.Event) -> None:
    while True:
        with sessions() as session:
            if sync_due(session):
                enqueue(session, JobKind.CATALOG_SYNC, sync_params(session), idempotency_key="catalog_sync")
                session.commit()
        if stop.wait(SCHEDULE_CHECK_SECONDS):
            return
