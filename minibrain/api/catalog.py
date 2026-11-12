import logging
import threading
from datetime import date

import httpx
import pydantic
from fastapi import APIRouter, Depends, Request
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from minibrain import provision
from minibrain.api.access import admin, viewer
from minibrain.api.deps import LocalNodeDep, SessionDep, SettingsDep
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
    PoolChoice,
)
from minibrain.api.training_plan import train_fit
from minibrain.api.views import job_info
from minibrain.auth.identity import current_actor
from minibrain.jobs.queue import enqueue
from minibrain.leader import Leader
from minibrain.ml.planner import Machine
from minibrain.models import hub
from minibrain.models.catalog import DAILY_SYNC_KEY, catalog_url, daily_sync, sync_params, upsert
from minibrain.models.copies import BUCKET
from minibrain.models.hardware import LOCAL_POOL, Hardware, NodeReport, pool_fit
from minibrain.models.hubadd import HubAddError, lookup, parse_repo
from minibrain.models.registry import start_download, weights_space
from minibrain.models.rules import licence_use
from minibrain.models.train_facts import trainer_machines
from minibrain.policy import load as load_policy
from minibrain.registry.compute import Pool, find_pool, pools
from minibrain.registry.models import BaseModel, CatalogModel, CatalogVariant, Job, JobKind, JobStatus, now
from minibrain.registry.service import ConflictError, NotFoundError
from minibrain.registry.settings_store import write
from minibrain.settings import Settings

router = APIRouter(prefix="/api/catalog")
SYNC_INTERVAL_SECONDS = 24 * 3600
SCHEDULE_CHECK_SECONDS = 3600.0

log = logging.getLogger("minibrain.catalog")


def pool_hardware(pool: Pool) -> Hardware:
    machines = [machine for machine in pool.machines() if machine.known]
    if not machines:
        return Hardware(pool.label, "Not reported yet", "unknown", None, None, "memory")
    return max(machines, key=lambda machine: machine.memory_bytes or 0)


def local_pool(session: Session, node: NodeReport) -> Pool:
    return find_pool(pools(session, node), LOCAL_POOL)


def local_info(session: Session, settings: Settings, node: NodeReport, entry: CatalogModel) -> CatalogEntry:
    pool = local_pool(session, node)
    return entry_info(session, settings, entry, pool.machines(), trainer_machines([pool]))


def cached_fully(variant: CatalogVariant) -> bool:
    from huggingface_hub import try_to_load_from_cache

    for entry in variant.files:
        found = try_to_load_from_cache(variant.repo, entry["path"], revision=variant.revision)
        if not isinstance(found, str):
            return False
    return True


def ensure_reachable(session: Session, entry: CatalogModel, variant: CatalogVariant) -> None:
    if cached_fully(variant):
        return
    load_policy(session).outbound(hub.endpoint())
    if hub.CONNECTIVITY.check() is False:
        raise ConflictError("Offline: downloads need a connection. Import the model files instead.")
    if entry.gated and hub.token() is None:
        raise ConflictError(
            f"{entry.name} is gated. Accept its licence at {hub.endpoint()}/{variant.repo} "
            "and set HF_TOKEN on the minibrain server, then retry."
        )


def added_for(session: Session, settings: Settings, entry: CatalogModel) -> list[AddedInfo]:
    added: list[AddedInfo] = []
    for model in session.scalars(select(BaseModel).where(BaseModel.catalog_id == entry.id)):
        availability = base_availability(model, model_job(session, model.id), settings)
        added.append(AddedInfo(key=model.id, variant_id=model.variant_id, availability=availability, error=model.error))
    return added


def variant_info(
    entry: CatalogModel, variant: CatalogVariant, machines: list[Hardware], trainers: list[Machine]
) -> CatalogVariantInfo:
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
        fit=FitInfo(**pool_fit(variant.weights_bytes, variant.requires, machines)),
        train_fit=train_fit(entry, variant, trainers),
    )


def entry_info(
    session: Session, settings: Settings, entry: CatalogModel, machines: list[Hardware], trainers: list[Machine]
) -> CatalogEntry:
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
        license_use=licence_use(entry.license),
        gated=entry.gated,
        recommended=entry.recommended,
        recommendation=entry.recommendation,
        popularity=entry.popularity,
        context_tokens=entry.context_tokens,
        released=date.fromisoformat(entry.released) if entry.released else None,
        family=entry.family,
        generation=entry.generation,
        architecture=entry.architecture,
        tier=entry.tier,
        params_b=entry.params_b,
        moe=entry.moe,
        superseded_by=entry.superseded_by,
        origin=entry.origin,
        variants=[variant_info(entry, variant, machines, trainers) for variant in entry.variants],
        added=added_for(session, settings, entry),
    )


def latest_sync(session: Session) -> Job | None:
    query = select(Job).where(Job.kind == JobKind.CATALOG_SYNC).order_by(Job.id.desc()).limit(1)
    return session.scalar(query)


@router.get("", dependencies=[Depends(viewer)], summary="List the model catalogue")
def catalogue(
    session: SessionDep, settings: SettingsDep, node: LocalNodeDep, pool: str | None = None
) -> CatalogResponse:
    found = pools(session, node)
    chosen = find_pool(found, pool)
    machines = chosen.machines()
    trainers = trainer_machines([chosen])
    policy = load_policy(session)
    entries = session.scalars(select(CatalogModel).order_by(CatalogModel.position))
    synced = [entry.synced_at for entry in session.scalars(select(CatalogModel)) if entry.synced_at is not None]
    sync = latest_sync(session)
    space = weights_space(session, settings)
    return CatalogResponse(
        entries=[entry_info(session, settings, entry, machines, trainers) for entry in entries],
        hardware=HardwareInfo(**pool_hardware(chosen).as_dict()),
        pools=[PoolChoice(name=item.name, label=item.label) for item in found if item.machines() or item is chosen],
        pool=chosen.name,
        online=hub.CONNECTIVITY.check() if policy.outbound_allowed(hub.endpoint()) else False,
        offline_forced=hub.offline() or not policy.outbound_allowed(hub.endpoint()),
        hub_add_allowed=policy["model_sources"] == "any",
        downloads_allowed=policy["model_sources"] != "imports",
        store_free_bytes=space.free,
        store_total_bytes=space.total,
        store_kind="s3" if space.kind == BUCKET else "folder",
        store_label=space.label,
        staging_free_bytes=space.staging_free,
        endpoint=hub.endpoint(),
        token_configured=hub.token() is not None,
        synced_at=max(synced, default=None),
        sync_job=job_info(sync) if sync is not None else None,
        catalog_url=catalog_url(),
    )


@router.post(
    "/{catalog_id}/download", status_code=202, dependencies=[Depends(admin)], summary="Download a catalogue model"
)
def download(
    catalog_id: str, body: DownloadRequest, request: Request, session: SessionDep, settings: SettingsDep
) -> ModelRow:
    from minibrain.api.base_models import row_of

    entry = session.get(CatalogModel, catalog_id)
    variant = session.get(CatalogVariant, body.variant)
    if entry is None or variant is None or variant.catalog_id != entry.id:
        raise NotFoundError(f"{catalog_id} has no variant {body.variant}")
    if not body.accept_license:
        raise ConflictError(f"Review and accept the {entry.license_name} before downloading {entry.name}")
    ensure_reachable(session, entry, variant)
    model = start_download(session, settings, entry, variant, current_actor())
    session.commit()
    return row_of(session, settings, request, model)


class HubAddRequest(pydantic.BaseModel):
    repo: str


@router.post(
    "/hub", status_code=201, dependencies=[Depends(admin)], summary="Add a Hugging Face model to the catalogue"
)
def add_from_hub(body: HubAddRequest, session: SessionDep, settings: SettingsDep, node: LocalNodeDep) -> CatalogEntry:
    policy = load_policy(session)
    policy.add_from_hub()
    policy.outbound(hub.endpoint())
    try:
        repo = parse_repo(body.repo)
    except HubAddError as error:
        raise ConflictError(str(error)) from error
    existing = session.scalar(select(CatalogModel).where(CatalogModel.repo == repo))
    if existing is not None:
        return local_info(session, settings, node, existing)
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
    return local_info(session, settings, node, added)


@router.delete(
    "/{catalog_id}", status_code=204, dependencies=[Depends(admin)], summary="Remove a model from the catalogue"
)
def remove_from_catalogue(catalog_id: str, session: SessionDep) -> None:
    entry = session.get(CatalogModel, catalog_id)
    if entry is None:
        raise NotFoundError(f"{catalog_id} is not in the catalogue")
    if entry.origin != "hub":
        raise ConflictError("Only models added from Hugging Face can be removed from the catalogue")
    if session.scalar(select(BaseModel.id).where(BaseModel.catalog_id == catalog_id).limit(1)) is not None:
        raise ConflictError(f"{entry.name} is on this install; delete the model first")
    session.delete(entry)
    session.commit()


@router.post("/sync", status_code=202, dependencies=[Depends(admin)], summary="Sync the catalogue")
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


class CatalogSettings(pydantic.BaseModel):
    daily_sync: bool


class CatalogSettingsInfo(CatalogSettings):
    daily_sync_locked: str | None = None


def catalog_settings(session: Session) -> CatalogSettingsInfo:
    locked = provision.provided("catalogue").source("daily_sync")
    return CatalogSettingsInfo(daily_sync=daily_sync(session), daily_sync_locked=locked)


@router.get("/settings", dependencies=[Depends(viewer)], summary="Read catalogue settings")
def read_settings(session: SessionDep) -> CatalogSettingsInfo:
    return catalog_settings(session)


@router.put("/settings", dependencies=[Depends(admin)], summary="Change catalogue settings")
def update_settings(body: CatalogSettings, session: SessionDep) -> CatalogSettingsInfo:
    if body.daily_sync != daily_sync(session):
        provision.provided("catalogue").refuse("daily_sync", "Check every day")
    write(session, DAILY_SYNC_KEY, body.daily_sync)
    session.commit()
    return catalog_settings(session)


def sync_due(session: Session) -> bool:
    url = catalog_url()
    if hub.offline() or url is None or not daily_sync(session) or not load_policy(session).outbound_allowed(url):
        return False
    last = latest_sync(session)
    if last is not None and last.status in (JobStatus.QUEUED, JobStatus.RUNNING):
        return False
    return last is None or (now() - last.created_at).total_seconds() > SYNC_INTERVAL_SECONDS


def schedule_forever(sessions: sessionmaker[Session], stop: threading.Event, leader: Leader) -> None:
    while True:
        try:
            if leader.held():
                with sessions() as session:
                    if sync_due(session):
                        enqueue(session, JobKind.CATALOG_SYNC, sync_params(session), idempotency_key="catalog_sync")
                        session.commit()
        except Exception:
            log.exception("catalogue sync scheduling failed")
        if stop.wait(SCHEDULE_CHECK_SECONDS):
            return
