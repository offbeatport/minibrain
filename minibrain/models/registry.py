import re
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.base_models import BASE_MODELS, QWEN_STOP_TOKENS, BaseModelSpec
from minibrain.jobs.queue import enqueue
from minibrain.registry.models import CatalogModel, CatalogVariant, JobKind, Model, ModelStatus, now
from minibrain.registry.service import ConflictError, NotFoundError
from minibrain.settings import Settings

ACTIVE_STATUSES = (ModelStatus.DOWNLOADING, ModelStatus.IMPORTING)


def models_dir(settings: Settings) -> Path:
    return settings.home / "models"


def model_dir(settings: Settings, model_id: str) -> Path:
    return models_dir(settings) / model_id


def files_present(settings: Settings, model: Model) -> bool:
    folder = model_dir(settings, model.id)
    return bool(model.files) and all(
        (folder / entry["path"]).is_file() and (folder / entry["path"]).stat().st_size == entry["size"]
        for entry in model.files
    )


def spec_for(settings: Settings, model: Model) -> BaseModelSpec:
    return BaseModelSpec(
        key=model.id,
        repo=model.repo or "",
        revision=model.revision or "",
        license=model.license or "",
        template_kwargs=dict(model.template_kwargs),
        stop_tokens=tuple(model.stop_tokens) or QWEN_STOP_TOKENS,
        path=str(model_dir(settings, model.id)),
        trainable=model.trainable,
    )


def resolve_spec(session: Session, settings: Settings, key: str) -> BaseModelSpec:
    model = session.get(Model, key)
    if model is not None and model.status == ModelStatus.AVAILABLE:
        return spec_for(settings, model)
    builtin = BASE_MODELS.get(key)
    if builtin is None:
        raise NotFoundError(f"base model {key} is not available on this install")
    return builtin


def model_id_for(variant: CatalogVariant) -> str:
    return variant.catalog_id if variant.position == 0 else variant.id.replace(":", "-")


def download_params(settings: Settings, model: Model, variant: CatalogVariant, gated: bool) -> dict[str, Any]:
    return {
        "model_id": model.id,
        "name": model.name,
        "repo": variant.repo,
        "revision": model.revision,
        "files": model.files,
        "gated": gated,
        "out": str(model_dir(settings, model.id)),
    }


def start_download(
    session: Session, settings: Settings, entry: CatalogModel, variant: CatalogVariant, acknowledged_by: str
) -> Model:
    model_id = model_id_for(variant)
    model = session.get(Model, model_id)
    if model is not None and model.status in (*ACTIVE_STATUSES, ModelStatus.AVAILABLE):
        raise ConflictError(f"{model.name} is already {model.status}")
    name = entry.name if variant.position == 0 else f"{entry.name} {variant.precision.upper()}"
    if model is None:
        model = Model(id=model_id, source="download", name=name, description=entry.description, status="")
        session.add(model)
    model.catalog_id = entry.id
    model.variant_id = variant.id
    model.repo = variant.repo
    model.revision = variant.revision
    model.files = list(variant.files)
    model.size_bytes = variant.size_bytes
    model.status = ModelStatus.DOWNLOADING
    model.error = None
    apply_catalogue(model, entry, variant)
    model.license_ack_by = acknowledged_by
    model.license_ack_at = now()
    model.updated_at = now()
    session.flush()
    params = download_params(settings, model, variant, entry.gated)
    enqueue(session, JobKind.DOWNLOAD, params, idempotency_key=f"download:{model.id}", model_id=model.id)
    return model


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9.]+", "-", name.lower()).strip("-")
    return slug[:48].strip("-") or "model"


def catalogue_manifests(session: Session) -> list[dict[str, Any]]:
    return [
        {"id": variant.id, "repo": variant.repo, "revision": variant.revision, "files": variant.files}
        for variant in session.scalars(select(CatalogVariant))
    ]


def import_params(session: Session, settings: Settings, model: Model) -> dict[str, Any]:
    kind, _, location = (model.source_path or "").partition(":")
    return {
        "model_id": model.id,
        "source_type": kind,
        "location": location,
        "variant_id": model.variant_id,
        "catalog": catalogue_manifests(session),
        "out": str(model_dir(settings, model.id)),
    }


def apply_catalogue(model: Model, entry: CatalogModel, variant: CatalogVariant) -> None:
    model.catalog_id = entry.id
    model.variant_id = variant.id
    model.repo = variant.repo
    model.revision = variant.revision
    model.trainable = entry.trainable and variant.runtimes == ["transformers"]
    model.template_kwargs = dict(entry.template_kwargs)
    model.stop_tokens = list(entry.stop_tokens)
    model.license = entry.license


def start_import(
    session: Session,
    settings: Settings,
    name: str,
    source_type: str,
    location: str,
    description: str,
    tags: list[str],
    variant_id: str | None = None,
) -> Model:
    model_id = slugify(name)
    if session.get(Model, model_id) is not None:
        raise ConflictError(f"a model called {model_id} already exists")
    model = Model(
        id=model_id,
        source="import",
        name=name.strip(),
        description=description.strip(),
        tags=tags,
        source_path=f"{source_type}:{location}",
        variant_id=variant_id,
        status=ModelStatus.IMPORTING,
        trainable=False,
        stop_tokens=[],
    )
    session.add(model)
    session.flush()
    params = import_params(session, settings, model)
    enqueue(session, JobKind.IMPORT, params, idempotency_key=f"import:{model.id}", model_id=model.id)
    return model


def retry(session: Session, settings: Settings, model: Model) -> Model:
    if model.status not in (ModelStatus.FAILED, ModelStatus.CANCELLED):
        raise ConflictError(f"{model.name} is {model.status}; only failed or cancelled transfers can be retried")
    if model.source == "import":
        model.status = ModelStatus.IMPORTING
        params = import_params(session, settings, model)
        enqueue(session, JobKind.IMPORT, params, idempotency_key=f"import:{model.id}", model_id=model.id)
    else:
        variant = model.variant
        if variant is None:
            raise ConflictError(f"{model.name} has no catalogue entry to download from")
        model.status = ModelStatus.DOWNLOADING
        entry = session.get(CatalogModel, variant.catalog_id)
        params = download_params(settings, model, variant, bool(entry and entry.gated))
        enqueue(session, JobKind.DOWNLOAD, params, idempotency_key=f"download:{model.id}", model_id=model.id)
    model.error = None
    model.updated_at = now()
    return model


def trainable_bases(session: Session) -> list[str]:
    downloaded = session.scalars(select(Model.id).where(Model.status == ModelStatus.AVAILABLE, Model.trainable))
    return sorted(set(BASE_MODELS) | set(downloaded))
