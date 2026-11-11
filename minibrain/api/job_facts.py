from typing import Any

from sqlalchemy.orm import Session

from minibrain.api.schemas import JobSetup, TrainingSetup
from minibrain.data.dataset_versions import version_number
from minibrain.jobs.metrics import latest_data
from minibrain.models.registry import base_publisher
from minibrain.registry.models import BaseModel, DatasetVersion, Job, JobKind
from minibrain.tasks.service import held_out_score

SFT = "sft"
TRAINING_METHODS = (SFT,)
SCORED_KINDS = (JobKind.TRAIN, JobKind.EVAL)
TRAIN_START = "train.start"


def text(data: dict[str, Any], key: str) -> str | None:
    value = data.get(key)
    return str(value) if isinstance(value, str) and value else None


def number(data: dict[str, Any], key: str) -> float | None:
    value = data.get(key)
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else None


def whole(data: dict[str, Any], key: str) -> int | None:
    value = number(data, key)
    return None if value is None else int(value)


def mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def method_of(job: Job) -> str | None:
    return SFT if job.kind == JobKind.TRAIN else None


def requested_recipe(job: Job) -> dict[str, Any]:
    return mapping((job.params or {}).get("recipe"))


def finished_recipe(job: Job) -> dict[str, Any]:
    return mapping((job.result or {}).get("summary"))


def run_recipe(job: Job) -> dict[str, Any]:
    if job.kind != JobKind.TRAIN:
        return {}
    return finished_recipe(job) or requested_recipe(job)


def variant_of(base: BaseModel | None) -> str | None:
    if base is None or base.variant is None or not base.variant.precision:
        return None
    return base.variant.precision.upper()


def job_facts(job: Job) -> dict[str, Any]:
    recipe = run_recipe(job)
    base = job.base_model
    scored = job.version is not None and job.kind in SCORED_KINDS
    return {
        "base_model_name": base.name if base is not None else None,
        "publisher": base_publisher(base) if base is not None else None,
        "variant": variant_of(base),
        "score": held_out_score(job.version) if scored and job.version is not None else None,
        "method": method_of(job),
        "strategy": text(recipe, "strategy"),
        "rank": whole(recipe, "rank"),
    }


def dataset_rows(dataset_version: DatasetVersion) -> int:
    return dataset_version.rows or sum(dataset_version.counts.values())


def training_setup(session: Session, job: Job) -> TrainingSetup:
    started = mapping(latest_data(session, job.id, (TRAIN_START,)))
    finished = finished_recipe(job)
    fitted = finished or mapping(started.get("recipe"))
    requested = requested_recipe(job)
    recipe = fitted or requested
    changed = recipe.get("overrides") or requested.get("overrides") or []
    return TrainingSetup(
        method=SFT,
        planned=bool(fitted),
        strategy=text(recipe, "strategy"),
        precision=text(recipe, "precision"),
        rank=whole(recipe, "rank"),
        epochs=number(recipe, "epochs"),
        learning_rate=number(recipe, "learning_rate"),
        batch=whole(recipe, "batch"),
        seq_len=whole(recipe, "seq_len"),
        max_rows=whole(recipe, "max_rows"),
        examples=whole(finished, "examples") or whole(started, "examples"),
        held_out=whole(started, "held_out"),
        changed=[str(name) for name in changed] if isinstance(changed, list) else [],
    )


def job_setup(session: Session, job: Job) -> JobSetup | None:
    version, base = job.version, job.base_model
    if version is None and base is None:
        return None
    shown = base if base is not None else session.get(BaseModel, version.base_model) if version else None
    dataset_version = version.dataset_version if version is not None else None
    dataset = dataset_version.dataset if dataset_version is not None else None
    return JobSetup(
        dataset=dataset.slug if dataset is not None else None,
        dataset_version=version_number(dataset_version) if dataset_version is not None else None,
        dataset_rows=dataset_rows(dataset_version) if dataset_version is not None else None,
        version_kind=version.kind if version is not None else None,
        base_model=shown.id if shown is not None else version.base_model if version is not None else None,
        base_model_name=shown.name if shown is not None else None,
        variant=variant_of(base),
        revision=base.revision if base is not None else None,
        size_bytes=base.size_bytes if base is not None and base.size_bytes else None,
        training=training_setup(session, job) if job.kind == JobKind.TRAIN else None,
    )
