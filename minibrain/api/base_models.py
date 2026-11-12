import time
from typing import Any

from fastapi import APIRouter, Depends, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.api.access import admin, viewer
from minibrain.api.deps import (
    BackendDep,
    LocalNodeDep,
    SessionDep,
    SettingsDep,
    get_local_node,
)
from minibrain.api.model_health import HealthContext, health_context
from minibrain.api.model_rows import EngineHealth, all_rows, base_row, model_job
from minibrain.api.schemas import (
    BaseModelDetail,
    FileState,
    FitInfo,
    ImportCheck,
    ImportRequest,
    InspectRequest,
    LocationRequest,
    ModelFile,
    ModelRow,
    ModelUpdate,
    TestRequest,
    TestResponse,
)
from minibrain.api.training_plan import base_train_fit
from minibrain.artifacts import ArtifactStore
from minibrain.auth.identity import current_actor
from minibrain.ml.context import FinalError
from minibrain.models.copies import BUCKET
from minibrain.models.hardware import pool_fit
from minibrain.models.health import CORRUPT, LOAD_PROBLEMS, content_hash, file_states, set_health
from minibrain.models.inspect import inspect_location, source_type_of
from minibrain.models.registry import (
    missing_files,
    model_folder,
    relocate,
    require_usable,
    resolve_spec,
    retry,
    start_import,
    start_reimport,
    start_repair,
    start_verify,
    store_label,
)
from minibrain.models.train_facts import base_facts, config_base, trainer_machines
from minibrain.models.usage import touch
from minibrain.registry.compute import find_pool, pools
from minibrain.registry.models import AuditEvent, BaseModel, BaseModelStatus, CatalogModel, Model, now
from minibrain.registry.service import ConflictError, NotFoundError, check_rename, no_model
from minibrain.serve.backend import CompletionRequest, EngineUnavailableError
from minibrain.settings import Settings
from minibrain.tags import merged_tags, user_tags
from minibrain.teardown import cancel_stop, require_idle, undeploy_base

router = APIRouter(prefix="/api")


def health_for(request: Request) -> EngineHealth:
    if request.app.state.engines is None:
        return lambda _key: "running"
    backend = request.app.state.backend
    return lambda key: backend.health(key)


def get_base_model(session: Session, key: str) -> BaseModel:
    model = session.get(BaseModel, key)
    if model is None and session.scalar(select(Model.id).where(Model.slug == key)) is not None:
        raise NotFoundError(f"{key} is a custom model; this needs a base model")
    if model is None:
        raise no_model(session, key)
    return model


def idle_base_model(session: Session, key: str) -> BaseModel:
    model = get_base_model(session, key)
    require_idle(model.teardown, model.name)
    return model


def context_for(session: Session, settings: Settings, request: Request) -> HealthContext:
    return health_context(session, settings, get_local_node(request))


def row_of(session: Session, settings: Settings, request: Request, model: BaseModel) -> ModelRow:
    context = context_for(session, settings, request)
    job = model_job(session, model.id)
    return base_row(model, job, settings, health_for(request), context=context, teardown=model.teardown)


def model_row(
    request: Request, session: Session, settings: Settings, store: ArtifactStore, kind: str, key: str
) -> ModelRow:
    rows = all_rows(session, settings, store, health_for(request), context_for(session, settings, request))
    found = next((row for row in rows if row.kind == kind and row.key == key), None)
    if found is None:
        raise no_model(session, key)
    return found


def wake_teardowns(request: Request) -> None:
    request.app.state.teardowns.wake()


def file_rows(settings: Settings, model: BaseModel) -> list[ModelFile]:
    sizes = missing_files(settings, model) if model.status == BaseModelStatus.AVAILABLE else {}
    flagged = file_states(model) if model.health == CORRUPT else {}
    checked = model.verified_at is not None
    rows: list[ModelFile] = []
    for entry in model.files:
        path = str(entry["path"])
        state: FileState = "ok" if checked and entry.get("sha256") else "unchecked"
        found = sizes.get(path) or flagged.get(path)
        if found in ("corrupt", "missing", "wrong_size"):
            state = found
        rows.append(ModelFile(path=path, size=int(entry["size"]), sha256=entry.get("sha256"), state=state))
    return rows


def size_facts(session: Session, settings: Settings, model: BaseModel) -> tuple[int | None, int | None]:
    if model.status != BaseModelStatus.AVAILABLE:
        return None, None
    facts = base_facts(session, settings, model.id)
    return round(facts.params) or None, facts.context


def detail_of(session: Session, settings: Settings, request: Request, model: BaseModel) -> BaseModelDetail:
    row = row_of(session, settings, request, model)
    entry = session.get(CatalogModel, model.catalog_id) if model.catalog_id else None
    parameters, context = size_facts(session, settings, model)
    return BaseModelDetail(
        **row.model_dump(),
        source=model.source,
        repo=model.repo,
        latest_revision=model.variant.latest_revision if model.variant else None,
        source_path=model.source_path,
        storage_path=str(model_folder(settings, model)),
        store="s3" if model.store == BUCKET else "folder",
        store_label=store_label(session, model),
        files=file_rows(settings, model),
        license=model.license,
        license_name=entry.license_name if entry else None,
        license_url=entry.license_url if entry else None,
        license_ack_by=model.license_ack_by,
        license_ack_at=model.license_ack_at,
        variant_id=model.variant_id,
        deployed=model.deployed,
        verified=model.verified,
        verified_at=model.verified_at,
        content_hash=content_hash(model.files),
        relocated=model.path is not None,
        parameters=parameters,
        context_tokens=context,
    )


@router.post(
    "/models/inspect", dependencies=[Depends(admin)], summary="Check a folder or bucket before importing a base model"
)
def inspect(body: InspectRequest, session: SessionDep, settings: SettingsDep, node: LocalNodeDep) -> ImportCheck:
    found = inspect_location(session, settings, body.location, body.connection_id)
    config = found.pop("config", None)
    if config is not None:
        weights = found["weights_bytes"]
        pool = find_pool(pools(session, node), None)
        base = config_base(found["name"], config, weights, found["quantized"])
        found |= {
            "fit": FitInfo(**pool_fit(weights, {}, pool.machines())),
            "train_fit": base_train_fit(base, trainer_machines([pool])),
        }
    return ImportCheck(**found)


@router.post(
    "/models/import",
    status_code=202,
    dependencies=[Depends(admin)],
    summary="Import a base model from a folder or bucket",
)
def import_model(body: ImportRequest, request: Request, session: SessionDep, settings: SettingsDep) -> ModelRow:
    tags = user_tags(body.tags)
    try:
        kind = body.source_type or source_type_of(body.location)
    except FinalError as error:
        raise ConflictError(str(error)) from error
    model = start_import(
        session,
        settings,
        body.name,
        kind,
        body.location.strip(),
        body.description,
        tags,
        body.variant_id,
        body.connection_id,
        body.api_name,
    )
    session.commit()
    return row_of(session, settings, request, model)


def update_base(session: Session, model: BaseModel, body: ModelUpdate) -> None:
    if body.name is not None:
        check_rename(session, model.name, body.name)
        model.name = body.name.strip()
    if body.description is not None:
        model.description = body.description.strip()
    if body.tags is not None:
        model.tags = merged_tags(model.tags, body.tags)
    model.updated_at = now()


def audit(session: Session, action: str, model: BaseModel, **detail: Any) -> None:
    session.add(
        AuditEvent(actor=current_actor(), action=action, target=model.id, detail={"name": model.name, **detail})
    )


@router.post(
    "/models/{name}/verify", status_code=202, dependencies=[Depends(admin)], summary="Verify a base model's files"
)
def verify_base(name: str, request: Request, session: SessionDep, settings: SettingsDep) -> BaseModelDetail:
    model = idle_base_model(session, name)
    job = start_verify(session, settings, model)
    audit(session, "model.verify", model, job=job.id, files=len(model.files))
    session.commit()
    return detail_of(session, settings, request, model)


@router.post(
    "/models/{name}/repair",
    status_code=202,
    dependencies=[Depends(admin)],
    summary="Download a base model's damaged files again",
)
def repair_base(name: str, request: Request, session: SessionDep, settings: SettingsDep) -> BaseModelDetail:
    model = idle_base_model(session, name)
    job = start_repair(session, settings, model)
    audit(session, "model.repair", model, job=job.id, source=f"{model.repo}@{model.revision}")
    session.commit()
    return detail_of(session, settings, request, model)


@router.post(
    "/models/{name}/reimport",
    status_code=202,
    dependencies=[Depends(admin)],
    summary="Import a base model's files again from another location",
)
def reimport_base(
    name: str, body: LocationRequest, request: Request, session: SessionDep, settings: SettingsDep
) -> BaseModelDetail:
    model = idle_base_model(session, name)
    job = start_reimport(session, settings, model, body.location, body.connection_id)
    audit(session, "model.reimport", model, job=job.id, source=body.location.strip())
    session.commit()
    return detail_of(session, settings, request, model)


@router.post("/models/{name}/relocate", dependencies=[Depends(admin)], summary="Point a base model at files that moved")
def relocate_base(
    name: str, body: LocationRequest, request: Request, session: SessionDep, settings: SettingsDep
) -> BaseModelDetail:
    model = idle_base_model(session, name)
    before = str(model_folder(settings, model))
    job = relocate(session, settings, model, body.location)
    audit(session, "model.relocate", model, job=job.id, **{"from": before, "to": str(model_folder(settings, model))})
    session.commit()
    return detail_of(session, settings, request, model)


@router.post("/models/{name}/recheck", dependencies=[Depends(admin)], summary="Clear a base model's start-up failure")
def recheck_base(name: str, request: Request, session: SessionDep, settings: SettingsDep) -> BaseModelDetail:
    model = get_base_model(session, name)
    if model.health not in LOAD_PROBLEMS:
        raise ConflictError(f"{model.name} has no start-up failure to clear")
    set_health(model, None)
    session.commit()
    if request.app.state.engines is not None:
        request.app.state.engines.stop_one(model.id)
    return detail_of(session, settings, request, model)


@router.post(
    "/models/{name}/retry",
    status_code=202,
    dependencies=[Depends(admin)],
    summary="Retry a base model's failed download or import",
)
def retry_base(name: str, request: Request, session: SessionDep, settings: SettingsDep) -> BaseModelDetail:
    model = retry(session, settings, idle_base_model(session, name))
    session.commit()
    return detail_of(session, settings, request, model)


def deploy_base(session: Session, settings: Settings, model: BaseModel, deployed: bool) -> bool:
    if not deployed:
        return undeploy_base(session, model, current_actor()) is not None
    if model.status != BaseModelStatus.AVAILABLE:
        raise ConflictError(f"{model.name} is {model.status}; deploy it once its files are available")
    require_usable(session, settings, model.id)
    cancel_stop(session, model.teardown, model.name)
    if not model.deployed:
        audit(session, "model.deploy", model)
    model.deployed = True
    model.updated_at = now()
    return False


@router.post("/models/{name}/test", dependencies=[Depends(viewer)], summary="Send a prompt to a base model")
def test_base(
    name: str, body: TestRequest, session: SessionDep, settings: SettingsDep, backend: BackendDep
) -> TestResponse:
    model = get_base_model(session, name)
    if model.status != BaseModelStatus.AVAILABLE:
        raise ConflictError(f"{model.name} is {model.status}; test it once its files are available")
    require_usable(session, settings, model.id)
    touch(session, model.id)
    session.commit()
    spec = resolve_spec(session, settings, name)
    started = time.monotonic()
    try:
        completion = backend.complete(
            CompletionRequest(spec, [{"role": "user", "content": body.text}], None, body.max_tokens)
        )
    except EngineUnavailableError as error:
        raise ConflictError(str(error)) from error
    return TestResponse(
        model=name,
        output=completion.text,
        latency_ms=(time.monotonic() - started) * 1000,
        prompt_tokens=completion.prompt_tokens,
        completion_tokens=completion.completion_tokens,
    )
