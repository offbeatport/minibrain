import os
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func, make_url, select
from sqlalchemy.orm import Session

from minibrain import provision
from minibrain.api.access import admin, viewer
from minibrain.api.deps import BackendDep, LocalNodeDep, SessionDep, SettingsDep, StoreDep
from minibrain.api.schemas import (
    DeviceInfo,
    InfrastructureInfo,
    InstallSettings,
    LoadedModel,
    SnapshotUsage,
    StorageCheck,
    StorageSettings,
    StorageUpdate,
    StoreInfo,
    SystemInfo,
)
from minibrain.artifacts import ArtifactStore
from minibrain.auth.identity import current_actor
from minibrain.data.limits import load_limits
from minibrain.data.snapshot import EVAL_MAX, GOLDEN_MAX, MIN_ROWS, SHOTS_MAX
from minibrain.models.hardware import LOCAL_POOL, NodeReport
from minibrain.models.registry import models_dir
from minibrain.object_store import CREDENTIAL_ENV, S3, StorageConfig, StorageError, load_config, read_secret
from minibrain.object_store import apply as apply_storage
from minibrain.object_store import check as check_storage
from minibrain.object_store import clean as clean_storage
from minibrain.object_store import save as save_storage
from minibrain.recipes import DEFAULT_RECIPE
from minibrain.registry.compute import pools
from minibrain.registry.files import ArtifactKind
from minibrain.registry.models import Artifact, Job, Model, ModelStatus, Snapshot, Version
from minibrain.serve.backend import ServingBackend
from minibrain.settings import Settings
from minibrain.storage import disk_space

router = APIRouter(prefix="/api", tags=["system"])

MEGABYTE = 1024 * 1024


def device_info() -> DeviceInfo:
    import torch

    from minibrain.ml.devices import pick_device, training_device

    accelerator, total, used = None, None, None
    if torch.cuda.is_available():
        free, capacity = torch.cuda.mem_get_info()
        accelerator, total, used = torch.cuda.get_device_name(0), capacity / MEGABYTE, (capacity - free) / MEGABYTE
    elif torch.backends.mps.is_available():
        accelerator = "Apple GPU (Metal)"
        total = torch.mps.recommended_max_memory() / MEGABYTE
        used = torch.mps.driver_allocated_memory() / MEGABYTE
    return DeviceInfo(
        inference=pick_device(),
        training=training_device(),
        accelerator=accelerator,
        memory_total_mb=total,
        memory_used_mb=used,
        cpu_count=os.cpu_count() or 1,
    )


def loaded_models(backend: ServingBackend) -> list[LoadedModel]:
    return [
        LoadedModel(base_model=item["base_model"], device=item.get("device") or "", adapters=item.get("adapters", []))
        for item in backend.status()
    ]


@router.get("/system", dependencies=[Depends(viewer)])
def system(request: Request, session: SessionDep, backend: BackendDep) -> SystemInfo:
    counts = session.execute(select(Job.status, func.count()).group_by(Job.status)).all()
    return SystemInfo(
        device=device_info(),
        jobs={status: count for status, count in counts},
        loaded=loaded_models(backend),
        loops=request.app.state.leader.describe(),
    )


def folder_store(name: str, path: Path, used: int | None) -> StoreInfo:
    space = disk_space(path)
    return StoreInfo(
        name=name,
        kind="folder",
        location=str(path),
        used_bytes=used,
        free_bytes=space.free if space else None,
        total_bytes=space.total if space else None,
    )


def database_store(settings: Settings) -> StoreInfo:
    url = make_url(settings.database_url)
    if url.get_backend_name() != "sqlite":
        location = f"{url.host or 'localhost'}:{url.port or 5432}/{url.database or ''}"
        return StoreInfo(
            name="Database", kind="postgres", location=location, used_bytes=None, free_bytes=None, total_bytes=None
        )
    path = Path(url.database or "")
    files = [path, path.with_name(f"{path.name}-wal")]
    used = sum(item.stat().st_size for item in files if item.is_file())
    return folder_store("Database", path, used).model_copy(update={"kind": "sqlite"})


Setup = Literal["one_machine", "remote_gpus", "distributed"]


def setup_of(session: Session, node: NodeReport, database: StoreInfo) -> Setup:
    if database.kind == "postgres":
        return "distributed"
    found = pools(session, node)
    remote = any(pool.name != LOCAL_POOL and pool.nodes for pool in found) or any(
        item.host != node.host for pool in found for item in pool.nodes
    )
    return "remote_gpus" if remote else "one_machine"


def artifact_store(name: str, settings: Settings, store: ArtifactStore, used: int) -> StoreInfo:
    if store.writes_remote and store.remote is not None:
        return StoreInfo(
            name=name, kind="s3", location=store.remote.describe(), used_bytes=used, free_bytes=None, total_bytes=None
        )
    return folder_store(name, settings.artifacts_dir(), used)


def secret_reference(found: provision.Provided) -> str | None:
    ref = provision.storage_secret_ref(found)
    if ref is None:
        return None
    kind, where = ref
    return f"the environment variable {where}" if kind == "env" else f"the file {where}"


def storage_settings(session: Session, settings: Settings, store: ArtifactStore) -> StorageSettings:
    config = load_config(session)
    found = provision.provided("storage")
    return StorageSettings(
        kind="s3" if config.kind == S3 else "local",
        endpoint=config.endpoint,
        bucket=config.bucket,
        prefix=config.prefix,
        region=config.region,
        access_key=config.access_key,
        secret_set=bool(read_secret(settings)),
        secret_from_environment=bool(os.environ.get(CREDENTIAL_ENV, "").strip()),
        secret_reference=secret_reference(found),
        locked=found.locked_by(),
        location=store.remote.describe() if store.writes_remote and store.remote else str(settings.artifacts_dir()),
    )


def storage_update(body: StorageUpdate) -> StorageConfig:
    return StorageConfig(
        kind=body.kind,
        endpoint=body.endpoint,
        bucket=body.bucket,
        prefix=body.prefix,
        region=body.region,
        access_key=body.access_key,
    )


@router.get("/settings/storage", dependencies=[Depends(admin)])
def read_storage(session: SessionDep, settings: SettingsDep, store: StoreDep) -> StorageSettings:
    return storage_settings(session, settings, store)


@router.put("/settings/storage", dependencies=[Depends(admin)])
def update_storage(body: StorageUpdate, session: SessionDep, settings: SettingsDep, store: StoreDep) -> StorageSettings:
    try:
        save_storage(session, settings, storage_update(body), body.secret, current_actor())
    except StorageError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    session.commit()
    apply_storage(store, session, settings)
    return storage_settings(session, settings, store)


@router.post("/settings/storage/test", dependencies=[Depends(admin)])
def test_storage(body: StorageUpdate, settings: SettingsDep) -> StorageCheck:
    config = storage_update(body)
    try:
        cleaned = clean_storage(config)
        check_storage(cleaned, body.secret or read_secret(settings))
    except StorageError as error:
        return StorageCheck(ok=False, message=str(error))
    return StorageCheck(ok=True, message=f"Wrote, read back and removed a test object in {cleaned.bucket}.")


@router.get("/system/infrastructure", dependencies=[Depends(viewer)])
def infrastructure(
    session: SessionDep, settings: SettingsDep, node: LocalNodeDep, store: StoreDep
) -> InfrastructureInfo:
    database = database_store(settings)
    weights = session.scalar(select(func.sum(Model.size_bytes)).where(Model.status == ModelStatus.AVAILABLE))
    artifacts = session.scalar(select(func.sum(Artifact.size)).where(Artifact.kind != ArtifactKind.SNAPSHOT))
    usage = snapshot_usage(session)
    return InfrastructureInfo(
        setup=setup_of(session, node, database),
        host=node.host,
        home=str(settings.home),
        web=str(settings.web_dist),
        stores=[
            database,
            folder_store("Model files", models_dir(settings), int(weights or 0)),
            artifact_store("Dataset versions", settings, store, usage.size),
            artifact_store("Uploads, adapters and results", settings, store, int(artifacts or 0)),
        ],
        snapshots=usage,
    )


def snapshot_usage(session: Session) -> SnapshotUsage:
    snapshots = session.scalars(select(Snapshot).where(Snapshot.minibrain_id.is_(None))).all()
    used = set(session.scalars(select(Version.snapshot_id)))
    used |= {snapshot.base_id for snapshot in snapshots if snapshot.id in used and snapshot.base_id is not None}
    stored = {snapshot.artifact_id: snapshot.size for snapshot in snapshots if snapshot.artifact_id}
    return SnapshotUsage(
        count=len(snapshots),
        size=sum(stored.values()),
        for_versions=sum(snapshot.id in used for snapshot in snapshots),
        saved=sum(snapshot.saved and snapshot.id not in used for snapshot in snapshots),
        keep=load_limits(session).keep_snapshots,
    )


@router.get("/settings", dependencies=[Depends(viewer)])
def install_settings() -> InstallSettings:
    return InstallSettings(
        recipe=DEFAULT_RECIPE,
        splits={"golden": GOLDEN_MAX, "eval": EVAL_MAX, "shots": SHOTS_MAX, "min_rows": MIN_ROWS},
    )
