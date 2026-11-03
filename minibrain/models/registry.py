import re
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.base_models import BASE_MODELS, QWEN_STOP_TOKENS, BaseModelSpec
from minibrain.jobs.queue import enqueue
from minibrain.ml.context import FinalError
from minibrain.models import hub
from minibrain.models.health import MISSING, content_hash, listed, problem_of, size_problems
from minibrain.models.inspect import source_type_of
from minibrain.models.sources import HUB, S3, s3_endpoint
from minibrain.policy import load as load_policy
from minibrain.registry.models import (
    ACTIVE_JOB_STATUSES,
    CatalogModel,
    CatalogVariant,
    Job,
    JobKind,
    JobStatus,
    Model,
    ModelStatus,
    now,
)
from minibrain.registry.service import ConflictError, NotFoundError
from minibrain.settings import Settings
from minibrain.storage import missing_room

ACTIVE_STATUSES = (ModelStatus.DOWNLOADING, ModelStatus.IMPORTING)
TRANSFER_KINDS = (JobKind.DOWNLOAD, JobKind.IMPORT, JobKind.REPAIR)


def models_dir(settings: Settings) -> Path:
    return settings.home / "models"


def model_dir(settings: Settings, model_id: str) -> Path:
    return models_dir(settings) / model_id


def model_folder(settings: Settings, model: Model) -> Path:
    return Path(model.path) if model.path else model_dir(settings, model.id)


def files_present(settings: Settings, model: Model) -> bool:
    return bool(model.files) and not size_problems(model_folder(settings, model), model.files)


def gguf_file(model: Model) -> str | None:
    return next((str(entry["path"]) for entry in model.files if str(entry["path"]).endswith(".gguf")), None)


def spec_for(settings: Settings, model: Model) -> BaseModelSpec:
    weights_file = gguf_file(model)
    return BaseModelSpec(
        key=model.id,
        repo=model.repo or "",
        revision=model.revision or "",
        license=model.license or "",
        template_kwargs=dict(model.template_kwargs),
        stop_tokens=tuple(model.stop_tokens) or QWEN_STOP_TOKENS,
        path=str(model_folder(settings, model)),
        format="gguf" if weights_file else "safetensors",
        weights_file=weights_file,
        content_hash=content_hash(model.files),
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
        "out": str(model_folder(settings, model)),
    }


def ensure_room(settings: Settings, model_id: str, files: list[dict[str, Any]], size: int) -> None:
    problem = missing_room(model_dir(settings, model_id), files, size)
    if problem is not None:
        raise ConflictError(problem)


def start_download(
    session: Session, settings: Settings, entry: CatalogModel, variant: CatalogVariant, acknowledged_by: str
) -> Model:
    load_policy(session).download(variant.repo, entry.license, entry.origin)
    model_id = model_id_for(variant)
    model = session.get(Model, model_id)
    if model is not None and model.status in (*ACTIVE_STATUSES, ModelStatus.AVAILABLE):
        raise ConflictError(f"{model.name} is already {model.status}")
    ensure_room(settings, model_id, list(variant.files), variant.size_bytes)
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
        "out": str(model_folder(settings, model)),
    }


def apply_catalogue(model: Model, entry: CatalogModel, variant: CatalogVariant) -> None:
    model.catalog_id = entry.id
    model.variant_id = variant.id
    model.repo = variant.repo
    model.revision = variant.revision
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
    if source_type == S3:
        load_policy(session).outbound(s3_endpoint())
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
        stop_tokens=[],
    )
    session.add(model)
    session.flush()
    params = import_params(session, settings, model)
    enqueue(session, JobKind.IMPORT, params, idempotency_key=f"import:{model.id}", model_id=model.id)
    return model


def check_transfer(session: Session, model: Model) -> None:
    policy = load_policy(session)
    if model.source == "import":
        if (model.source_path or "").startswith(f"{S3}:"):
            policy.outbound(s3_endpoint())
        return
    variant = model.variant
    if variant is None:
        raise ConflictError(f"{model.name} has no catalogue entry to download from")
    entry = session.get(CatalogModel, variant.catalog_id)
    policy.download(variant.repo, entry.license if entry else "unknown", entry.origin if entry else "hub")
    policy.outbound(hub.endpoint())


def check_job(session: Session, job: Job) -> None:
    if job.kind == JobKind.CATALOG_SYNC:
        load_policy(session).outbound(str(job.params.get("url") or ""))
    model = session.get(Model, job.model_id) if job.model_id else None
    if model is None:
        return
    if job.kind in (JobKind.DOWNLOAD, JobKind.IMPORT):
        check_transfer(session, model)
    elif job.kind == JobKind.REPAIR:
        check_repair(session, model, str(job.params.get("source") or ""))


def last_transfer(session: Session, model: Model) -> Job | None:
    query = select(Job).where(Job.model_id == model.id, Job.kind.in_(TRANSFER_KINDS)).order_by(Job.id.desc())
    return session.scalar(query.limit(1))


def retry_repair(session: Session, settings: Settings, model: Model, job: Job) -> Model:
    if job.params.get("source") == HUB:
        start_repair(session, settings, model)
    else:
        start_reimport(session, settings, model, str(job.params.get("location") or ""))
    model.error = None
    model.updated_at = now()
    return model


def retry(session: Session, settings: Settings, model: Model) -> Model:
    last = last_transfer(session, model)
    if last is not None and last.kind == JobKind.REPAIR and last.status in (JobStatus.FAILED, JobStatus.CANCELLED):
        return retry_repair(session, settings, model, last)
    if model.status not in (ModelStatus.FAILED, ModelStatus.CANCELLED):
        raise ConflictError(f"{model.name} is {model.status}; only failed or cancelled transfers can be retried")
    check_transfer(session, model)
    if model.source == "import":
        model.status = ModelStatus.IMPORTING
        params = import_params(session, settings, model)
        enqueue(session, JobKind.IMPORT, params, idempotency_key=f"import:{model.id}", model_id=model.id)
    else:
        variant = model.variant
        if variant is None:
            raise ConflictError(f"{model.name} has no catalogue entry to download from")
        entry = session.get(CatalogModel, variant.catalog_id)
        model.status = ModelStatus.DOWNLOADING
        params = download_params(settings, model, variant, bool(entry and entry.gated))
        enqueue(session, JobKind.DOWNLOAD, params, idempotency_key=f"download:{model.id}", model_id=model.id)
    model.error = None
    model.updated_at = now()
    return model


def available_bases(session: Session) -> list[str]:
    downloaded = session.scalars(select(Model.id).where(Model.status == ModelStatus.AVAILABLE))
    return sorted(set(BASE_MODELS) | set(downloaded))


PENDING = (ModelStatus.IMPORTING, ModelStatus.DOWNLOADING)


def base_readiness(session: Session, key: str) -> str:
    if key in BASE_MODELS:
        return "ready"
    model = session.get(Model, key)
    if model is None:
        return "missing"
    if model.status in PENDING:
        return "pending"
    if model.status != ModelStatus.AVAILABLE:
        return "missing"
    return "ready"


def active_job(session: Session, model: Model) -> Job | None:
    query = select(Job).where(Job.model_id == model.id, Job.status.in_(ACTIVE_JOB_STATUSES))
    return session.scalar(query.limit(1))


def ensure_idle(session: Session, model: Model) -> None:
    job = active_job(session, model)
    if job is not None:
        raise ConflictError(f"{model.name} has a {job.kind} job running; wait for it or cancel it first")


def require_usable(session: Session, settings: Settings, key: str) -> None:
    model = session.get(Model, key)
    if model is None:
        return
    problem = problem_of(model, model_folder(settings, model))
    if problem is not None:
        raise ConflictError(problem)


def base_hash(session: Session, key: str) -> str | None:
    model = session.get(Model, key)
    return content_hash(model.files) if model is not None and model.status == ModelStatus.AVAILABLE else None


def start_verify(session: Session, settings: Settings, model: Model) -> Job:
    if model.status != ModelStatus.AVAILABLE or not model.files:
        raise ConflictError(f"{model.name} is {model.status}; verify its files once they are installed")
    ensure_idle(session, model)
    params = {"model_id": model.id, "folder": str(model_folder(settings, model)), "files": list(model.files)}
    return enqueue(session, JobKind.VERIFY, params, idempotency_key=f"verify:{model.id}", model_id=model.id)


def repair_params(
    session: Session, settings: Settings, model: Model, source: str, location: str | None = None
) -> dict[str, Any]:
    params: dict[str, Any] = {
        "model_id": model.id,
        "name": model.name,
        "files": list(model.files),
        "out": str(model_folder(settings, model)),
        "source": source,
    }
    if source != HUB:
        return params | {"location": location}
    entry = session.get(CatalogModel, model.catalog_id) if model.catalog_id else None
    return params | {"repo": model.repo, "revision": model.revision, "gated": bool(entry and entry.gated)}


def check_repair(session: Session, model: Model, source: str) -> None:
    policy = load_policy(session)
    if source == S3:
        policy.outbound(s3_endpoint())
    if source != HUB:
        return
    entry = session.get(CatalogModel, model.catalog_id) if model.catalog_id else None
    licence = entry.license if entry else model.license or "unknown"
    policy.download(model.repo or "", licence, entry.origin if entry else "hub")
    policy.outbound(hub.endpoint())


def hub_repairable(session: Session, model: Model) -> bool:
    policy = load_policy(session)
    return (
        bool(model.repo and model.revision and model.files)
        and not hub.offline()
        and policy.outbound_allowed(hub.endpoint())
        and policy["model_sources"] != "imports"
    )


def start_repair(session: Session, settings: Settings, model: Model) -> Job:
    ensure_idle(session, model)
    if not model.files:
        raise ConflictError(f"{model.name} has no saved file list to repair against")
    if not (model.repo and model.revision):
        raise ConflictError(
            f"{model.name} was imported without a catalogue match, so there is nothing to download it from; "
            "re-import it from a folder or S3 path"
        )
    if hub.offline():
        raise ConflictError("Offline: repairs need a connection to the model hub; re-import from a folder or S3 path")
    check_repair(session, model, HUB)
    params = repair_params(session, settings, model, HUB)
    return enqueue(session, JobKind.REPAIR, params, idempotency_key=f"repair:{model.id}", model_id=model.id)


def start_reimport(session: Session, settings: Settings, model: Model, location: str) -> Job:
    ensure_idle(session, model)
    if not model.files:
        raise ConflictError(f"{model.name} has no saved file list to re-import against")
    try:
        source = source_type_of(location)
    except FinalError as error:
        raise ConflictError(str(error)) from error
    check_repair(session, model, source)
    params = repair_params(session, settings, model, source, location.strip())
    return enqueue(session, JobKind.REPAIR, params, idempotency_key=f"repair:{model.id}", model_id=model.id)


def size_mismatch(folder: Path, model: Model, problems: dict[str, str]) -> str:
    expected = {str(entry["path"]): int(entry["size"]) for entry in model.files}
    lines = [
        f"{path} is missing"
        if state == MISSING
        else f"{path} is {(folder / path).stat().st_size} bytes, expected {expected[path]}"
        for path, state in sorted(problems.items())
    ]
    return (
        f"{folder} does not hold {model.name}'s files: {listed(lines)}. "
        "Point to the folder that holds the files from the original install."
    )


def relocate(session: Session, settings: Settings, model: Model, location: str) -> Job:
    if model.status != ModelStatus.AVAILABLE:
        raise ConflictError(f"{model.name} is {model.status}; only installed models can point to a new location")
    ensure_idle(session, model)
    folder = Path(location.strip()).expanduser()
    if not folder.is_absolute():
        raise ConflictError("Give an absolute folder path on the server")
    if not folder.is_dir():
        raise ConflictError(f"{folder} is not a folder on the server")
    problems = size_problems(folder, model.files)
    if problems:
        raise ConflictError(size_mismatch(folder, model, problems))
    managed = model_dir(settings, model.id)
    model.path = None if managed.exists() and folder.resolve() == managed.resolve() else str(folder)
    model.updated_at = now()
    return start_verify(session, settings, model)
