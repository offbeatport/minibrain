import os
from importlib.metadata import PackageNotFoundError, version

from fastapi import APIRouter
from sqlalchemy import func, select

from minibrain.api.deps import BackendDep, SessionDep, SettingsDep
from minibrain.api.schemas import BaseModelInfo, DeviceInfo, InstallSettings, LoadedModel, SystemInfo
from minibrain.base_models import BASE_MODELS, DEFAULT_BASE_MODEL
from minibrain.data.snapshot import EVAL_MAX, GOLDEN_MAX, MIN_ROWS, SHOTS_MAX
from minibrain.recipes import DEFAULT_RECIPE
from minibrain.registry.models import Job
from minibrain.serve.backend import ServingBackend, TransformersBackend

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
    if not isinstance(backend, TransformersBackend):
        return []
    return [
        LoadedModel(base_model=key, device=runtime.device, adapters=sorted(runtime.adapters))
        for key, runtime in backend.runtimes.items()
    ]


@router.get("/system")
def system(session: SessionDep, backend: BackendDep) -> SystemInfo:
    counts = session.execute(select(Job.status, func.count()).group_by(Job.status)).all()
    return SystemInfo(
        device=device_info(),
        libraries={name: library_version(name) for name in LIBRARIES},
        jobs={status: count for status, count in counts},
        loaded=loaded_models(backend),
    )


@router.get("/settings")
def install_settings(settings: SettingsDep) -> InstallSettings:
    return InstallSettings(
        home=str(settings.home),
        database=str(settings.home / "minibrain.db"),
        web=str(settings.web_dist),
        base_models=[
            BaseModelInfo(key=spec.key, repo=spec.repo, revision=spec.revision, license=spec.license)
            for spec in BASE_MODELS.values()
        ],
        default_base_model=DEFAULT_BASE_MODEL,
        recipe=DEFAULT_RECIPE,
        splits={"golden": GOLDEN_MAX, "eval": EVAL_MAX, "shots": SHOTS_MAX, "min_rows": MIN_ROWS},
    )
