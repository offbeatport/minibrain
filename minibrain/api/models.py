import time
from typing import Any

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.orm import Session

from minibrain.api.access import admin, builder, viewer
from minibrain.api.deps import BackendDep, SessionDep, SettingsDep, StoreDep, get_local_node
from minibrain.api.model_health import HealthContext, health_context
from minibrain.api.model_rows import EngineHealth, all_rows, base_row, model_job
from minibrain.api.schemas import (
    BaseModelDetail,
    DeployRequest,
    FileState,
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
from minibrain.artifacts import ArtifactStore
from minibrain.auth.identity import current_actor
from minibrain.ml.context import FinalError
from minibrain.models.copies import BUCKET
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
from minibrain.models.usage import touch
from minibrain.registry.models import AuditEvent, CatalogModel, Model, ModelStatus, now
from minibrain.registry.service import ConflictError, NotFoundError
from minibrain.serve.backend import CompletionRequest, EngineUnavailableError
from minibrain.settings import Settings
from minibrain.tags import merged_tags, user_tags
from minibrain.teardown import cancel_stop, delete_base, require_idle, undeploy_base

router = APIRouter(prefix="/api/models", tags=["models"])


def health_for(request: Request) -> EngineHealth:
    if request.app.state.engines is None:
        return lambda _key: "running"
    backend = request.app.state.backend
    return lambda key: backend.health(key)


def get_model(session: Session, key: str) -> Model:
    model = session.get(Model, key)
    if model is None:
        raise NotFoundError(f"model {key} not found")
    return model


def idle_model(session: Session, key: str) -> Model:
    model = get_model(session, key)
    require_idle(model.teardown, model.name)
    return model


def context_for(session: Session, settings: Settings, request: Request) -> HealthContext:
    return health_context(session, settings, get_local_node(request))


def row_of(session: Session, settings: Settings, request: Request, model: Model) -> ModelRow:
    context = context_for(session, settings, request)
    job = model_job(session, model.id)
    return base_row(model, job, settings, health_for(request), context=context, teardown=model.teardown)


def model_row(
    request: Request, session: Session, settings: Settings, store: ArtifactStore, kind: str, key: str
) -> ModelRow:
    rows = all_rows(session, settings, store, health_for(request), context_for(session, settings, request))
    found = next((row for row in rows if row.kind == kind and row.key == key), None)
    if found is None:
        raise NotFoundError(f"model {key} not found")
    return found


def wake_teardowns(request: Request) -> None:
    request.app.state.teardowns.wake()


def file_rows(settings: Settings, model: Model) -> list[ModelFile]:
    sizes = missing_files(settings, model) if model.status == ModelStatus.AVAILABLE else {}
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


def detail_of(session: Session, settings: Settings, request: Request, model: Model) -> BaseModelDetail:
    row = row_of(session, settings, request, model)
    entry = session.get(CatalogModel, model.catalog_id) if model.catalog_id else None
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
    )


@router.get("", dependencies=[Depends(viewer)])
def list_models(request: Request, session: SessionDep, settings: SettingsDep, store: StoreDep) -> list[ModelRow]:
    return all_rows(session, settings, store, health_for(request), context_for(session, settings, request))


@router.post("/inspect", dependencies=[Depends(admin)])
def inspect(body: InspectRequest, session: SessionDep, settings: SettingsDep) -> ImportCheck:
    return ImportCheck(**inspect_location(session, settings, body.location, body.connection_id))


@router.post("/import", status_code=202, dependencies=[Depends(admin)])
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
    )
    session.commit()
    return row_of(session, settings, request, model)


@router.get("/base/{key}", dependencies=[Depends(viewer)])
def read_base(key: str, request: Request, session: SessionDep, settings: SettingsDep) -> BaseModelDetail:
    return detail_of(session, settings, request, get_model(session, key))


@router.patch("/base/{key}", dependencies=[Depends(admin)])
def update_base(
    key: str, body: ModelUpdate, request: Request, session: SessionDep, settings: SettingsDep
) -> BaseModelDetail:
    model = get_model(session, key)
    if body.name is not None:
        model.name = body.name.strip()
    if body.description is not None:
        model.description = body.description.strip()
    if body.tags is not None:
        model.tags = merged_tags(model.tags, body.tags)
    model.updated_at = now()
    session.commit()
    return detail_of(session, settings, request, model)


@router.delete("/base/{key}", status_code=202, dependencies=[Depends(admin)])
def delete_base_model(
    key: str,
    request: Request,
    session: SessionDep,
    settings: SettingsDep,
    store: StoreDep,
    cascade: bool = False,
    undeploy: bool = False,
) -> ModelRow:
    delete_base(session, get_model(session, key), current_actor(), cascade=cascade, undeploy=undeploy)
    session.commit()
    wake_teardowns(request)
    return model_row(request, session, settings, store, "base", key)


def audit(session: Session, action: str, model: Model, **detail: Any) -> None:
    session.add(
        AuditEvent(actor=current_actor(), action=action, target=model.id, detail={"name": model.name, **detail})
    )


@router.post("/base/{key}/verify", status_code=202, dependencies=[Depends(admin)])
def verify_base(key: str, request: Request, session: SessionDep, settings: SettingsDep) -> BaseModelDetail:
    model = idle_model(session, key)
    job = start_verify(session, settings, model)
    audit(session, "model.verify", model, job=job.id, files=len(model.files))
    session.commit()
    return detail_of(session, settings, request, model)


@router.post("/base/{key}/repair", status_code=202, dependencies=[Depends(admin)])
def repair_base(key: str, request: Request, session: SessionDep, settings: SettingsDep) -> BaseModelDetail:
    model = idle_model(session, key)
    job = start_repair(session, settings, model)
    audit(session, "model.repair", model, job=job.id, source=f"{model.repo}@{model.revision}")
    session.commit()
    return detail_of(session, settings, request, model)


@router.post("/base/{key}/reimport", status_code=202, dependencies=[Depends(admin)])
def reimport_base(
    key: str, body: LocationRequest, request: Request, session: SessionDep, settings: SettingsDep
) -> BaseModelDetail:
    model = idle_model(session, key)
    job = start_reimport(session, settings, model, body.location, body.connection_id)
    audit(session, "model.reimport", model, job=job.id, source=body.location.strip())
    session.commit()
    return detail_of(session, settings, request, model)


@router.post("/base/{key}/relocate", dependencies=[Depends(admin)])
def relocate_base(
    key: str, body: LocationRequest, request: Request, session: SessionDep, settings: SettingsDep
) -> BaseModelDetail:
    model = idle_model(session, key)
    before = str(model_folder(settings, model))
    job = relocate(session, settings, model, body.location)
    audit(session, "model.relocate", model, job=job.id, **{"from": before, "to": str(model_folder(settings, model))})
    session.commit()
    return detail_of(session, settings, request, model)


@router.post("/base/{key}/recheck", dependencies=[Depends(admin)])
def recheck_base(key: str, request: Request, session: SessionDep, settings: SettingsDep) -> BaseModelDetail:
    model = get_model(session, key)
    if model.health not in LOAD_PROBLEMS:
        raise ConflictError(f"{model.name} has no start-up failure to clear")
    set_health(model, None)
    session.commit()
    if request.app.state.engines is not None:
        request.app.state.engines.stop_one(model.id)
    return detail_of(session, settings, request, model)


@router.post("/base/{key}/retry", status_code=202, dependencies=[Depends(admin)])
def retry_base(key: str, request: Request, session: SessionDep, settings: SettingsDep) -> BaseModelDetail:
    model = retry(session, settings, idle_model(session, key))
    session.commit()
    return detail_of(session, settings, request, model)


@router.post("/base/{key}/deploy", dependencies=[Depends(builder)])
def deploy_base(
    key: str, body: DeployRequest, request: Request, response: Response, session: SessionDep, settings: SettingsDep
) -> BaseModelDetail:
    model = get_model(session, key)
    if not body.deployed:
        if undeploy_base(session, model, current_actor()) is not None:
            response.status_code = 202
        session.commit()
        wake_teardowns(request)
        return detail_of(session, settings, request, model)
    if model.status != ModelStatus.AVAILABLE:
        raise ConflictError(f"{model.name} is {model.status}; deploy it once its files are available")
    require_usable(session, settings, model.id)
    cancel_stop(session, model.teardown, model.name)
    if not model.deployed:
        audit(session, "model.deploy", model)
    model.deployed = True
    model.updated_at = now()
    session.commit()
    return detail_of(session, settings, request, model)


@router.post("/base/{key}/test", dependencies=[Depends(viewer)])
def test_base(
    key: str, body: TestRequest, session: SessionDep, settings: SettingsDep, backend: BackendDep
) -> TestResponse:
    model = get_model(session, key)
    if model.status != ModelStatus.AVAILABLE:
        raise ConflictError(f"{model.name} is {model.status}; test it once its files are available")
    require_usable(session, settings, model.id)
    touch(session, model.id)
    session.commit()
    spec = resolve_spec(session, settings, key)
    started = time.monotonic()
    try:
        completion = backend.complete(
            CompletionRequest(spec, [{"role": "user", "content": body.text}], None, body.max_tokens)
        )
    except EngineUnavailableError as error:
        raise ConflictError(str(error)) from error
    return TestResponse(
        model=key,
        output=completion.text,
        latency_ms=(time.monotonic() - started) * 1000,
        prompt_tokens=completion.prompt_tokens,
        completion_tokens=completion.completion_tokens,
    )
