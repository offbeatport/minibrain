from fastapi import APIRouter, Request

from minibrain.api.deps import BackendDep, SessionDep, SettingsDep
from minibrain.api.policies import LOCAL_USER
from minibrain.api.schemas import (
    CompleteRequest,
    CompleteResponse,
    MinibrainDetail,
    VersionCreate,
    VersionInfo,
)
from minibrain.api.views import detail, version_info
from minibrain.data.snapshots import cleanup, require_splits, snapshot_for_model
from minibrain.gateway.routes import run
from minibrain.jobs.queue import enqueue
from minibrain.jobs.specs import eval_params, train_params
from minibrain.models.registry import base_readiness, resolve_spec
from minibrain.registry.models import ACTIVE_JOB_STATUSES, AuditEvent, JobKind, VersionKind
from minibrain.registry.service import (
    ConflictError,
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
    readiness = base_readiness(session, minibrain.base_model)
    if readiness == "pending":
        raise ConflictError(f"{minibrain.base_model} is still being imported or downloaded; try once it is available")
    if readiness == "missing":
        raise ConflictError(f"{minibrain.base_model} is no longer on this install")
    if kind == VersionKind.LORA and resolve_spec(session, settings, minibrain.base_model).format == "gguf":
        raise ConflictError(
            f"{minibrain.base_model} has GGUF weights, which can be served but not fine-tuned; use safetensors"
        )
    recipe = {key: value for key, value in (("max_rows", body.max_rows), ("epochs", body.epochs)) if value is not None}
    require_splits(snapshot_for_model(session, settings, minibrain, saved=False))
    version = create_version(session, minibrain, kind, recipe if kind == VersionKind.LORA else {})
    if kind == VersionKind.LORA:
        params = train_params(session, settings, version)
        enqueue(session, JobKind.TRAIN, params, minibrain.id, version.id, f"train:{version.id}")
    else:
        params = eval_params(session, settings, version)
        enqueue(session, JobKind.EVAL, params, minibrain.id, version.id, f"eval:{version.id}")
    session.commit()
    return version_info(minibrain, version)


@router.delete("/minibrains/{slug}/versions/{number}", status_code=204)
def delete_version(slug: str, number: int, session: SessionDep, settings: SettingsDep) -> None:
    minibrain = get_minibrain(session, slug)
    version = get_version(minibrain, number)
    if minibrain.deployed and minibrain.current_version == number:
        raise ConflictError(f"{slug}@{number} is deployed; undeploy it first")
    if any(job.version_id == version.id and job.status in ACTIVE_JOB_STATUSES for job in minibrain.jobs):
        raise ConflictError(f"{slug}@{number} has a job running; cancel it first")
    if minibrain.current_version == number:
        minibrain.current_version = None
    session.add(
        AuditEvent(
            actor=LOCAL_USER,
            action="version.delete",
            target=f"{slug}@{number}",
            detail={"name": minibrain.name, "kind": version.kind, "status": version.status},
        )
    )
    session.delete(version)
    session.flush()
    cleanup(session, settings)
    session.commit()


@router.post("/minibrains/{slug}/versions/{number}/promote")
def promote_version(slug: str, number: int, session: SessionDep, settings: SettingsDep) -> MinibrainDetail:
    minibrain = get_minibrain(session, slug)
    promote(minibrain, get_version(minibrain, number))
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
