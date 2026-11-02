import os
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Request
from sqlalchemy import func, make_url, select
from sqlalchemy.orm import Session

from minibrain.api.deps import BackendDep, LocalNodeDep, SessionDep, SettingsDep
from minibrain.api.schemas import (
    DeviceInfo,
    InfrastructureInfo,
    InstallSettings,
    LoadedModel,
    StoreInfo,
    SystemInfo,
)
from minibrain.data.snapshot import EVAL_MAX, GOLDEN_MAX, MIN_ROWS, SHOTS_MAX
from minibrain.models.hardware import LOCAL_POOL, NodeReport
from minibrain.models.registry import models_dir
from minibrain.recipes import DEFAULT_RECIPE
from minibrain.registry.compute import pools
from minibrain.registry.models import Artifact, Job, Model, ModelStatus
from minibrain.serve.backend import ServingBackend
from minibrain.settings import Settings
from minibrain.storage import disk_space

router = APIRouter(prefix="/api", tags=["system"])

LIBRARIES = ("torch", "transformers", "peft", "trl", "duckdb", "fastapi")
MEGABYTE = 1024 * 1024


def library_version(name: str) -> str:
    try:
        return version(name)
    except PackageNotFoundError:
        return "not installed"


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


@router.get("/system")
def system(request: Request, session: SessionDep, backend: BackendDep) -> SystemInfo:
    counts = session.execute(select(Job.status, func.count()).group_by(Job.status)).all()
    return SystemInfo(
        device=device_info(),
        libraries={name: library_version(name) for name in LIBRARIES},
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


@router.get("/system/infrastructure")
def infrastructure(session: SessionDep, settings: SettingsDep, node: LocalNodeDep) -> InfrastructureInfo:
    database = database_store(settings)
    weights = session.scalar(select(func.sum(Model.size_bytes)).where(Model.status == ModelStatus.AVAILABLE))
    artifacts = session.scalar(select(func.sum(Artifact.size)))
    return InfrastructureInfo(
        setup=setup_of(session, node, database),
        host=node.host,
        home=str(settings.home),
        web=str(settings.web_dist),
        stores=[
            database,
            folder_store("Model files", models_dir(settings), int(weights or 0)),
            folder_store("Datasets, adapters and results", settings.artifacts_dir(), int(artifacts or 0)),
        ],
    )


@router.get("/settings")
def install_settings() -> InstallSettings:
    return InstallSettings(
        recipe=DEFAULT_RECIPE,
        splits={"golden": GOLDEN_MAX, "eval": EVAL_MAX, "shots": SHOTS_MAX, "min_rows": MIN_ROWS},
    )
