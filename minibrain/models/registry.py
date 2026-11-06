import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, object_session

from minibrain import storage
from minibrain.artifacts import ArtifactError
from minibrain.base_models import BASE_MODELS, QWEN_STOP_TOKENS, BaseModelSpec
from minibrain.connections.imports import check_connection_policy, pick_connection
from minibrain.encryption.envelope import EnvelopeError
from minibrain.jobs.queue import enqueue
from minibrain.ml.context import FinalError
from minibrain.models import hub
from minibrain.models.bucket import missing_objects, writes_bucket
from minibrain.models.copies import BUCKET, FOLDER
from minibrain.models.health import MISSING, content_hash, listed, problem_of, size_problems
from minibrain.models.inspect import source_type_of
from minibrain.models.sources import HUB, S3, s3_endpoint
from minibrain.models.templates import gguf_template, template_in_files
from minibrain.object_store import load_config
from minibrain.policy import load as load_policy
from minibrain.registry.files import store_for
from minibrain.registry.models import (
    ACTIVE_JOB_STATUSES,
    BaseModel,
    BaseModelStatus,
    CatalogModel,
    CatalogVariant,
    Job,
    JobKind,
    JobStatus,
    now,
)
from minibrain.registry.service import ConflictError, NotFoundError
from minibrain.serve.dialects import detect_reasoning, detect_tools
from minibrain.settings import Settings
from minibrain.storage import missing_room, staging_room

ACTIVE_STATUSES = (BaseModelStatus.DOWNLOADING, BaseModelStatus.IMPORTING)
MAIN_DISK = "Main server disk"
CONFIG_FILE = "config.json"
TRANSFER_KINDS = (JobKind.DOWNLOAD, JobKind.IMPORT, JobKind.REPAIR)


def models_dir(settings: Settings) -> Path:
    return settings.home / "models"


def model_dir(settings: Settings, base_model_id: str) -> Path:
    return models_dir(settings) / base_model_id


def model_folder(settings: Settings, model: BaseModel) -> Path:
    return Path(model.path) if model.path else model_dir(settings, model.id)


def staging_dir(settings: Settings, base_model_id: str) -> Path:
    return settings.work_dir() / "models" / base_model_id


def missing_files(settings: Settings, model: BaseModel) -> dict[str, str]:
    if model.store != BUCKET:
        return size_problems(model_folder(settings, model), model.files)
    session = object_session(model)
    if session is None:
        raise NotFoundError(f"{model.id} is not loaded from the database")
    return missing_objects(session, model)


def files_present(settings: Settings, model: BaseModel) -> bool:
    return bool(model.files) and not missing_files(settings, model)


def transfer_target(settings: Settings, model: BaseModel) -> dict[str, Any]:
    if not writes_bucket(store_for(settings)):
        return {"store": FOLDER, "out": str(model_folder(settings, model))}
    return {"store": BUCKET, "out": str(staging_dir(settings, model.id))}


def gguf_file(model: BaseModel) -> str | None:
    return next((str(entry["path"]) for entry in model.files if str(entry["path"]).endswith(".gguf")), None)


TEMPLATES: dict[tuple[str, str], str | None] = {}


def stored_file(settings: Settings, model: BaseModel, name: str) -> bytes | None:
    if model.store != BUCKET:
        local = model_folder(settings, model) / name
        return local.read_bytes() if local.is_file() else None
    entry = next((entry for entry in model.files if entry.get("path") == name and entry.get("sha256")), None)
    if entry is None:
        return None
    with store_for(settings).open(str(entry["sha256"])) as stream:
        return stream.read()


def read_chat_template(settings: Settings, model: BaseModel) -> str | None:
    weights = gguf_file(model)
    try:
        if weights is None:
            return template_in_files(lambda name: stored_file(settings, model, name))
        if model.store != BUCKET:
            with (model_folder(settings, model) / weights).open("rb") as stream:
                return gguf_template(stream)
        entry = next((item for item in model.files if item.get("path") == weights and item.get("sha256")), None)
        if entry is None:
            return None
        with store_for(settings).open(str(entry["sha256"])) as stream:
            return gguf_template(stream)
    except (OSError, ValueError, ArtifactError, EnvelopeError):
        return None


def chat_template(settings: Settings, model: BaseModel) -> str | None:
    found = content_hash(model.files)
    if found is None:
        return read_chat_template(settings, model)
    key = (model.id, found)
    if key not in TEMPLATES:
        TEMPLATES[key] = read_chat_template(settings, model)
    return TEMPLATES[key]


def spec_for(settings: Settings, model: BaseModel) -> BaseModelSpec:
    weights_file = gguf_file(model)
    template = chat_template(settings, model) if model.status == BaseModelStatus.AVAILABLE else None
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
        tools=detect_tools(template),
        reasoning=detect_reasoning(template),
    )


def resolve_spec(session: Session, settings: Settings, key: str) -> BaseModelSpec:
    model = session.get(BaseModel, key)
    if model is not None and model.status == BaseModelStatus.AVAILABLE:
        return spec_for(settings, model)
    builtin = BASE_MODELS.get(key)
    if builtin is None:
        raise NotFoundError(f"base model {key} is not available on this install")
    return builtin


def config_bytes(settings: Settings, model: BaseModel) -> bytes | None:
    return stored_file(settings, model, CONFIG_FILE)


def base_config(settings: Settings, model: BaseModel) -> dict[str, Any] | None:
    try:
        raw = config_bytes(settings, model)
        found = json.loads(raw) if raw is not None else None
    except (OSError, ValueError, ArtifactError, EnvelopeError):
        return None
    return found if isinstance(found, dict) else None


def quantization(session: Session, settings: Settings, key: str) -> str | None:
    if resolve_spec(session, settings, key).format == "gguf":
        return "gguf"
    model = session.get(BaseModel, key)
    config = base_config(settings, model) if model is not None else None
    found = config.get("quantization_config") if config else None
    method = found.get("quant_method") if isinstance(found, dict) else None
    return str(method) if method else None


def model_id_for(variant: CatalogVariant) -> str:
    return variant.catalog_id if variant.position == 0 else variant.id.replace(":", "-")


def download_params(settings: Settings, model: BaseModel, variant: CatalogVariant, gated: bool) -> dict[str, Any]:
    return {
        "base_model_id": model.id,
        "name": model.name,
        "repo": variant.repo,
        "revision": model.revision,
        "files": model.files,
        "gated": gated,
    } | transfer_target(settings, model)


@dataclass(frozen=True)
class WeightsSpace:
    kind: str
    label: str
    free: int | None
    total: int | None
    staging_free: int | None


def weights_space(session: Session, settings: Settings) -> WeightsSpace:
    if writes_bucket(store_for(settings)):
        staging = storage.disk_space(settings.work_dir())
        label = f"S3 · {load_config(session).bucket}"
        return WeightsSpace(BUCKET, label, None, None, staging.free if staging else None)
    space = storage.disk_space(models_dir(settings))
    return WeightsSpace(FOLDER, MAIN_DISK, space.free if space else None, space.total if space else None, None)


def store_label(session: Session, model: BaseModel) -> str:
    return f"S3 · {load_config(session).bucket}" if model.store == BUCKET else MAIN_DISK


def ensure_room(settings: Settings, base_model_id: str, files: list[dict[str, Any]], size: int) -> None:
    if writes_bucket(store_for(settings)):
        problem = staging_room(staging_dir(settings, base_model_id), files)
    else:
        problem = missing_room(model_dir(settings, base_model_id), files, size)
    if problem is not None:
        raise ConflictError(problem)


def start_download(
    session: Session, settings: Settings, entry: CatalogModel, variant: CatalogVariant, acknowledged_by: str
) -> BaseModel:
    load_policy(session).download(variant.repo, entry.license, entry.origin)
    base_model_id = model_id_for(variant)
    model = session.get(BaseModel, base_model_id)
    if model is not None and model.status in (*ACTIVE_STATUSES, BaseModelStatus.AVAILABLE):
        raise ConflictError(f"{model.name} is already {model.status}")
    ensure_room(settings, base_model_id, list(variant.files), variant.size_bytes)
    name = entry.name if variant.position == 0 else f"{entry.name} {variant.precision.upper()}"
    if model is None:
        model = BaseModel(id=base_model_id, source="download", name=name, description=entry.description, status="")
        session.add(model)
    model.catalog_id = entry.id
    model.variant_id = variant.id
    model.repo = variant.repo
    model.revision = variant.revision
    model.files = list(variant.files)
    model.size_bytes = variant.size_bytes
    model.status = BaseModelStatus.DOWNLOADING
    model.error = None
    apply_catalogue(model, entry, variant)
    model.license_ack_by = acknowledged_by
    model.license_ack_at = now()
    model.updated_at = now()
    session.flush()
    params = download_params(settings, model, variant, entry.gated)
    enqueue(session, JobKind.DOWNLOAD, params, idempotency_key=f"download:{model.id}", base_model_id=model.id)
    return model


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9.]+", "-", name.lower()).strip("-")
    return slug[:48].strip("-") or "model"


def catalogue_manifests(session: Session) -> list[dict[str, Any]]:
    return [
        {"id": variant.id, "repo": variant.repo, "revision": variant.revision, "files": variant.files}
        for variant in session.scalars(select(CatalogVariant))
    ]


def import_params(session: Session, settings: Settings, model: BaseModel) -> dict[str, Any]:
    kind, _, location = (model.source_path or "").partition(":")
    return {
        "base_model_id": model.id,
        "source_type": kind,
        "location": location,
        "variant_id": model.variant_id,
        "catalog": catalogue_manifests(session),
        "connection_id": model.connection_id,
    } | transfer_target(settings, model)


def apply_catalogue(model: BaseModel, entry: CatalogModel, variant: CatalogVariant) -> None:
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
    connection_id: int | None = None,
) -> BaseModel:
    connection = pick_connection(session, location, connection_id) if source_type == S3 else None
    check_s3_policy(session, source_type, connection.id if connection else None)
    base_model_id = slugify(name)
    if session.get(BaseModel, base_model_id) is not None:
        raise ConflictError(f"a model called {base_model_id} already exists")
    model = BaseModel(
        id=base_model_id,
        source="import",
        name=name.strip(),
        description=description.strip(),
        tags=tags,
        source_path=f"{source_type}:{location}",
        variant_id=variant_id,
        status=BaseModelStatus.IMPORTING,
        stop_tokens=[],
        connection_id=connection.id if connection else None,
    )
    session.add(model)
    session.flush()
    params = import_params(session, settings, model)
    enqueue(session, JobKind.IMPORT, params, idempotency_key=f"import:{model.id}", base_model_id=model.id)
    return model


def check_s3_policy(session: Session, source_type: str, connection_id: int | None) -> None:
    if source_type != S3:
        return
    if connection_id is not None:
        check_connection_policy(session, connection_id)
    else:
        load_policy(session).outbound(s3_endpoint())


def check_transfer(session: Session, model: BaseModel) -> None:
    policy = load_policy(session)
    if model.source == "import":
        kind = (model.source_path or "").partition(":")[0]
        check_s3_policy(session, kind, model.connection_id)
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
    model = session.get(BaseModel, job.base_model_id) if job.base_model_id else None
    if model is None:
        return
    if job.kind in (JobKind.DOWNLOAD, JobKind.IMPORT):
        check_transfer(session, model)
    elif job.kind == JobKind.REPAIR:
        check_repair(session, model, str(job.params.get("source") or ""), job.params.get("connection_id"))


def last_transfer(session: Session, model: BaseModel) -> Job | None:
    query = select(Job).where(Job.base_model_id == model.id, Job.kind.in_(TRANSFER_KINDS)).order_by(Job.id.desc())
    return session.scalar(query.limit(1))


def retry_repair(session: Session, settings: Settings, model: BaseModel, job: Job) -> BaseModel:
    if job.params.get("source") == HUB:
        start_repair(session, settings, model)
    else:
        location, connection_id = str(job.params.get("location") or ""), job.params.get("connection_id")
        start_reimport(session, settings, model, location, connection_id)
    model.error = None
    model.updated_at = now()
    return model


def retry(session: Session, settings: Settings, model: BaseModel) -> BaseModel:
    last = last_transfer(session, model)
    if last is not None and last.kind == JobKind.REPAIR and last.status in (JobStatus.FAILED, JobStatus.CANCELLED):
        return retry_repair(session, settings, model, last)
    if model.status not in (BaseModelStatus.FAILED, BaseModelStatus.CANCELLED):
        raise ConflictError(f"{model.name} is {model.status}; only failed or cancelled transfers can be retried")
    check_transfer(session, model)
    if model.source == "import":
        model.status = BaseModelStatus.IMPORTING
        params = import_params(session, settings, model)
        enqueue(session, JobKind.IMPORT, params, idempotency_key=f"import:{model.id}", base_model_id=model.id)
    else:
        variant = model.variant
        if variant is None:
            raise ConflictError(f"{model.name} has no catalogue entry to download from")
        entry = session.get(CatalogModel, variant.catalog_id)
        model.status = BaseModelStatus.DOWNLOADING
        params = download_params(settings, model, variant, bool(entry and entry.gated))
        enqueue(session, JobKind.DOWNLOAD, params, idempotency_key=f"download:{model.id}", base_model_id=model.id)
    model.error = None
    model.updated_at = now()
    return model


PENDING = (BaseModelStatus.IMPORTING, BaseModelStatus.DOWNLOADING)


def base_readiness(session: Session, key: str) -> str:
    if key in BASE_MODELS:
        return "ready"
    model = session.get(BaseModel, key)
    if model is None:
        return "missing"
    if model.status in PENDING:
        return "pending"
    if model.status != BaseModelStatus.AVAILABLE:
        return "missing"
    return "ready"


def active_job(session: Session, model: BaseModel) -> Job | None:
    query = select(Job).where(Job.base_model_id == model.id, Job.status.in_(ACTIVE_JOB_STATUSES))
    return session.scalar(query.limit(1))


def ensure_idle(session: Session, model: BaseModel) -> None:
    job = active_job(session, model)
    if job is not None:
        raise ConflictError(f"{model.name} has a {job.kind} job running; wait for it or cancel it first")


def require_usable(session: Session, settings: Settings, key: str) -> None:
    model = session.get(BaseModel, key)
    if model is None:
        return
    problem = problem_of(model, missing_files(settings, model))
    if problem is not None:
        raise ConflictError(problem)


def base_hash(session: Session, key: str) -> str | None:
    model = session.get(BaseModel, key)
    return content_hash(model.files) if model is not None and model.status == BaseModelStatus.AVAILABLE else None


def start_verify(session: Session, settings: Settings, model: BaseModel) -> Job:
    if model.status != BaseModelStatus.AVAILABLE or not model.files:
        raise ConflictError(f"{model.name} is {model.status}; verify its files once they are installed")
    ensure_idle(session, model)
    params = {
        "base_model_id": model.id,
        "folder": str(model_folder(settings, model)),
        "files": list(model.files),
        "store": model.store,
    }
    return enqueue(session, JobKind.VERIFY, params, idempotency_key=f"verify:{model.id}", base_model_id=model.id)


def repair_params(
    session: Session,
    settings: Settings,
    model: BaseModel,
    source: str,
    location: str | None = None,
    connection_id: int | None = None,
) -> dict[str, Any]:
    params: dict[str, Any] = {
        "base_model_id": model.id,
        "name": model.name,
        "files": list(model.files),
        "source": source,
    } | transfer_target(settings, model)
    if source != HUB:
        return params | {"location": location, "connection_id": connection_id}
    entry = session.get(CatalogModel, model.catalog_id) if model.catalog_id else None
    return params | {"repo": model.repo, "revision": model.revision, "gated": bool(entry and entry.gated)}


def check_repair(session: Session, model: BaseModel, source: str, connection_id: int | None = None) -> None:
    policy = load_policy(session)
    check_s3_policy(session, source, connection_id)
    if source != HUB:
        return
    entry = session.get(CatalogModel, model.catalog_id) if model.catalog_id else None
    licence = entry.license if entry else model.license or "unknown"
    policy.download(model.repo or "", licence, entry.origin if entry else "hub")
    policy.outbound(hub.endpoint())


def start_repair(session: Session, settings: Settings, model: BaseModel) -> Job:
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
    return enqueue(session, JobKind.REPAIR, params, idempotency_key=f"repair:{model.id}", base_model_id=model.id)


def start_reimport(
    session: Session, settings: Settings, model: BaseModel, location: str, connection_id: int | None = None
) -> Job:
    ensure_idle(session, model)
    if not model.files:
        raise ConflictError(f"{model.name} has no saved file list to re-import against")
    try:
        source = source_type_of(location)
    except FinalError as error:
        raise ConflictError(str(error)) from error
    connection = pick_connection(session, location, connection_id) if source == S3 else None
    chosen = connection.id if connection else None
    check_repair(session, model, source, chosen)
    params = repair_params(session, settings, model, source, location.strip(), chosen)
    return enqueue(session, JobKind.REPAIR, params, idempotency_key=f"repair:{model.id}", base_model_id=model.id)


def size_mismatch(folder: Path, model: BaseModel, problems: dict[str, str]) -> str:
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


def relocate(session: Session, settings: Settings, model: BaseModel, location: str) -> Job:
    if model.status != BaseModelStatus.AVAILABLE:
        raise ConflictError(f"{model.name} is {model.status}; only installed models can point to a new location")
    if model.store == BUCKET:
        raise ConflictError(f"{model.name}'s files are in the bucket; re-import it from that folder instead")
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
