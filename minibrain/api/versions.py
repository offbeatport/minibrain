from fastapi import APIRouter, Request

from minibrain.api.deps import BackendDep, SessionDep, SettingsDep
from minibrain.api.schemas import (
    CompleteRequest,
    CompleteResponse,
    KeyCreate,
    KeyCreated,
    KeyInfo,
    MinibrainDetail,
    PromoteRequest,
    VersionCreate,
    VersionInfo,
)
from minibrain.api.views import detail, key_info, version_info
from minibrain.gateway.routes import run
from minibrain.jobs.queue import enqueue
from minibrain.jobs.specs import eval_params, train_params
from minibrain.registry.models import ApiKey, JobKind, VersionKind
from minibrain.registry.service import (
    ConflictError,
    NotFoundError,
    create_key,
    create_version,
    get_minibrain,
    get_version,
    promote,
)
from minibrain.tasks.classify import parse_label

router = APIRouter(prefix="/api", tags=["versions"])


@router.get("/minibrains/{slug}/versions")
def list_versions(slug: str, session: SessionDep) -> list[VersionInfo]:
    minibrain = get_minibrain(session, slug)
    versions = sorted(minibrain.versions, key=lambda version: version.number, reverse=True)
    return [version_info(minibrain, version) for version in versions]


@router.post("/minibrains/{slug}/versions", status_code=201)
def add_version(slug: str, body: VersionCreate, session: SessionDep, settings: SettingsDep) -> VersionInfo:
    minibrain = get_minibrain(session, slug)
    kind = VersionKind(body.kind)
    recipe = {key: value for key, value in (("max_rows", body.max_rows), ("epochs", body.epochs)) if value is not None}
    version = create_version(session, minibrain, kind, recipe if kind == VersionKind.LORA else {})
    if kind == VersionKind.LORA:
        params = train_params(session, settings, version)
        enqueue(session, JobKind.TRAIN, params, minibrain.id, version.id, f"train:{version.id}")
    else:
        params = eval_params(session, settings, version)
        enqueue(session, JobKind.EVAL, params, minibrain.id, version.id, f"eval:{version.id}")
    session.commit()
    return version_info(minibrain, version)


@router.post("/minibrains/{slug}/versions/{number}/promote")
def promote_version(
    slug: str, number: int, body: PromoteRequest, session: SessionDep, settings: SettingsDep
) -> MinibrainDetail:
    minibrain = get_minibrain(session, slug)
    promote(minibrain, get_version(minibrain, number), body.override)
    session.commit()
    return detail(settings, minibrain)


@router.post("/minibrains/{slug}/complete")
def complete(
    slug: str, body: CompleteRequest, session: SessionDep, backend: BackendDep, request: Request
) -> CompleteResponse:
    minibrain = get_minibrain(session, slug)
    name = minibrain.slug if body.version is None else f"{minibrain.slug}@{body.version}"
    config = request.app.state.gateway_config.current()
    route = config.routes.get(name)
    if route is None:
        raise ConflictError("no ready version to run; score or train one first")
    completion = run(backend, config, route, [{"role": "user", "content": body.text}], body.max_tokens)
    return CompleteResponse(
        model=f"{route.slug}@{route.version}",
        output=completion.text,
        label=parse_label(completion.text, route.labels),
        latency_ms=completion.seconds * 1000,
        prompt_tokens=completion.prompt_tokens,
        completion_tokens=completion.completion_tokens,
    )


@router.get("/minibrains/{slug}/keys")
def list_keys(slug: str, session: SessionDep) -> list[KeyInfo]:
    return [key_info(key) for key in get_minibrain(session, slug).keys]


@router.post("/minibrains/{slug}/keys", status_code=201)
def add_key(slug: str, body: KeyCreate, session: SessionDep) -> KeyCreated:
    key, secret = create_key(session, body.name, minibrain=get_minibrain(session, slug))
    return KeyCreated(secret=secret, **key_info(key).model_dump())


@router.delete("/minibrains/{slug}/keys/{key_id}", status_code=204)
def delete_key(slug: str, key_id: int, session: SessionDep) -> None:
    minibrain = get_minibrain(session, slug)
    key = session.get(ApiKey, key_id)
    if key is None or key.minibrain_id != minibrain.id:
        raise NotFoundError(f"key {key_id} not found")
    session.delete(key)
    session.commit()
