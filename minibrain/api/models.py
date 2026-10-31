import time
from typing import Any

from fastapi import APIRouter, Request
from sqlalchemy.orm import Session

from minibrain.api.deps import BackendDep, SessionDep, SettingsDep, StoreDep
from minibrain.api.model_rows import Health, all_rows, base_row, model_job
from minibrain.api.schemas import (
    BaseModelDetail,
    DeployRequest,
    ImportRequest,
    KeyCreate,
    KeyCreated,
    KeyInfo,
    ModelFile,
    ModelRow,
    ModelUpdate,
    TestRequest,
    TestResponse,
)
from minibrain.api.views import key_info
from minibrain.models.registry import model_dir, resolve_spec, retry, start_import
from minibrain.models.sources import configured
from minibrain.registry.models import ApiKey, CatalogModel, Model, ModelStatus, now
from minibrain.registry.service import ConflictError, NotFoundError, create_key
from minibrain.serve.backend import CompletionRequest, EngineUnavailableError
from minibrain.settings import Settings

router = APIRouter(prefix="/api/models", tags=["models"])


def health_for(request: Request) -> Health:
    if request.app.state.engines is None:
        return lambda _key: "running"
    backend = request.app.state.backend
    return lambda key: backend.health(key)


def get_model(session: Session, key: str) -> Model:
    model = session.get(Model, key)
    if model is None:
        raise NotFoundError(f"model {key} not found")
    return model


def row_of(session: Session, settings: Settings, request: Request, model: Model) -> ModelRow:
    return base_row(model, model_job(session, model.id), settings, health_for(request))


def detail_of(session: Session, settings: Settings, request: Request, model: Model) -> BaseModelDetail:
    row = row_of(session, settings, request, model)
    entry = session.get(CatalogModel, model.catalog_id) if model.catalog_id else None
    return BaseModelDetail(
        **row.model_dump(),
        source=model.source,
        repo=model.repo,
        revision=model.revision,
        latest_revision=model.variant.latest_revision if model.variant else None,
        source_path=model.source_path,
        storage_path=str(model_dir(settings, model.id)),
        files=[ModelFile(path=f["path"], size=f["size"], sha256=f.get("sha256")) for f in model.files],
        size_bytes=model.size_bytes,
        error=model.error,
        license=model.license,
        license_name=entry.license_name if entry else None,
        license_url=entry.license_url if entry else None,
        license_ack_by=model.license_ack_by,
        license_ack_at=model.license_ack_at,
        catalog_id=model.catalog_id,
        variant_id=model.variant_id,
        deployed=model.deployed,
    )


@router.get("")
def list_models(
    request: Request, session: SessionDep, settings: SettingsDep, store: StoreDep, archived: bool = False
) -> list[ModelRow]:
    rows = all_rows(session, settings, store, health_for(request))
    return [row for row in rows if archived or not row.archived]


@router.get("/sources")
def model_sources() -> list[dict[str, Any]]:
    return configured()


@router.post("/import", status_code=202)
def import_model(body: ImportRequest, request: Request, session: SessionDep, settings: SettingsDep) -> ModelRow:
    tags = [tag.strip() for tag in body.tags if tag.strip()]
    model = start_import(session, settings, body.name, body.source_type, body.location.strip(), body.description, tags)
    session.commit()
    return row_of(session, settings, request, model)


@router.get("/base/{key}")
def read_base(key: str, request: Request, session: SessionDep, settings: SettingsDep) -> BaseModelDetail:
    return detail_of(session, settings, request, get_model(session, key))


@router.patch("/base/{key}")
def update_base(
    key: str, body: ModelUpdate, request: Request, session: SessionDep, settings: SettingsDep
) -> BaseModelDetail:
    model = get_model(session, key)
    if body.name is not None:
        model.name = body.name.strip()
    if body.description is not None:
        model.description = body.description.strip()
    if body.tags is not None:
        model.tags = sorted({tag.strip() for tag in body.tags if tag.strip()})
    if body.archived is not None:
        model.archived_at = now() if body.archived else None
    model.updated_at = now()
    session.commit()
    return detail_of(session, settings, request, model)


@router.post("/base/{key}/retry", status_code=202)
def retry_base(key: str, request: Request, session: SessionDep, settings: SettingsDep) -> BaseModelDetail:
    model = retry(session, settings, get_model(session, key))
    session.commit()
    return detail_of(session, settings, request, model)


@router.post("/base/{key}/deploy")
def deploy_base(
    key: str, body: DeployRequest, request: Request, session: SessionDep, settings: SettingsDep
) -> BaseModelDetail:
    model = get_model(session, key)
    if body.deployed and model.status != ModelStatus.AVAILABLE:
        raise ConflictError(f"{model.name} is {model.status}; deploy it once its files are available")
    model.deployed = body.deployed
    model.updated_at = now()
    session.commit()
    return detail_of(session, settings, request, model)


@router.post("/base/{key}/test")
def test_base(
    key: str, body: TestRequest, session: SessionDep, settings: SettingsDep, backend: BackendDep
) -> TestResponse:
    model = get_model(session, key)
    if model.status != ModelStatus.AVAILABLE:
        raise ConflictError(f"{model.name} is {model.status}; test it once its files are available")
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


@router.get("/base/{key}/keys")
def list_base_keys(key: str, session: SessionDep) -> list[KeyInfo]:
    model = get_model(session, key)
    return [key_info(item) for item in session.query(ApiKey).filter(ApiKey.model_id == model.id)]


@router.post("/base/{key}/keys", status_code=201)
def add_base_key(key: str, body: KeyCreate, session: SessionDep) -> KeyCreated:
    created, secret = create_key(session, body.name, model_id=get_model(session, key).id)
    return KeyCreated(secret=secret, **key_info(created).model_dump())


@router.delete("/base/{key}/keys/{key_id}", status_code=204)
def delete_base_key(key: str, key_id: int, session: SessionDep) -> None:
    model = get_model(session, key)
    found = session.get(ApiKey, key_id)
    if found is None or found.model_id != model.id:
        raise NotFoundError(f"key {key_id} not found")
    session.delete(found)
    session.commit()
