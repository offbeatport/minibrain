from typing import Any

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from minibrain.api.access import builder, sees_rows, viewer
from minibrain.api.deps import BackendDep, SessionDep, SettingsDep
from minibrain.api.schemas import (
    CompleteRequest,
    CompleteResponse,
    MinibrainDetail,
    VersionCreate,
    VersionInfo,
)
from minibrain.api.views import detail, version_info
from minibrain.auth.identity import current_actor
from minibrain.data.snapshots import cleanup, require_splits, training_snapshot
from minibrain.gateway.routes import response_id, run
from minibrain.jobs.queue import enqueue
from minibrain.jobs.specs import eval_params, train_params
from minibrain.models.health import base_changed
from minibrain.models.registry import base_hash, base_readiness, require_usable, resolve_spec
from minibrain.models.usage import touch
from minibrain.registry.models import ACTIVE_JOB_STATUSES, AuditEvent, JobKind, Minibrain, Model, VersionKind
from minibrain.registry.prices import load_prices
from minibrain.registry.service import (
    ConflictError,
    create_version,
    get_minibrain,
    get_version,
    promote,
)
from minibrain.tasks.classify import parse_label
from minibrain.teardown import cancel_stop, require_idle

router = APIRouter(prefix="/api", tags=["versions"])


def audit_version(session: Session, minibrain: Minibrain, number: int, action: str, **detail: Any) -> None:
    target = f"{minibrain.slug}@{number}"
    session.add(
        AuditEvent(actor=current_actor(), action=action, target=target, detail={"name": minibrain.name, **detail})
    )


@router.get("/minibrains/{slug}/versions", dependencies=[Depends(viewer)])
def list_versions(slug: str, session: SessionDep) -> list[VersionInfo]:
    minibrain = get_minibrain(session, slug)
    versions = sorted(minibrain.versions, key=lambda version: version.number, reverse=True)
    prices = load_prices(session)
    found = [version_info(minibrain, version, prices) for version in versions]
    return found if sees_rows() else [info.model_copy(update={"mistakes": []}) for info in found]


@router.post("/minibrains/{slug}/versions", status_code=201, dependencies=[Depends(builder)])
def add_version(slug: str, body: VersionCreate, session: SessionDep, settings: SettingsDep) -> VersionInfo:
    minibrain = get_minibrain(session, slug)
    require_idle(minibrain.teardown, minibrain.name)
    base = session.get(Model, minibrain.base_model)
    if base is not None:
        require_idle(base.teardown, base.name)
    kind = VersionKind(body.kind)
    readiness = base_readiness(session, minibrain.base_model)
    if readiness == "pending":
        raise ConflictError(f"{minibrain.base_model} is still being imported or downloaded; try once it is available")
    if readiness == "missing":
        raise ConflictError(f"{minibrain.base_model} is no longer on this install")
    require_usable(session, settings, minibrain.base_model)
    if kind == VersionKind.LORA and resolve_spec(session, settings, minibrain.base_model).format == "gguf":
        raise ConflictError(
            f"{minibrain.base_model} has GGUF weights, which can be served but not fine-tuned; use safetensors"
        )
    recipe = {key: value for key, value in (("max_rows", body.max_rows), ("epochs", body.epochs)) if value is not None}
    snapshot = training_snapshot(session, settings, minibrain, body.snapshot_id)
    require_splits(snapshot)
    version = create_version(session, minibrain, kind, recipe if kind == VersionKind.LORA else {}, snapshot)
    audit_version(
        session,
        minibrain,
        number=version.number,
        action="version.create",
        kind=str(kind),
        snapshot=version.snapshot.hash,
        recipe=dict(version.recipe),
    )
    if kind == VersionKind.LORA:
        version.base_hash = base_hash(session, minibrain.base_model)
        params = train_params(session, settings, version)
        enqueue(session, JobKind.TRAIN, params, minibrain.id, version.id, f"train:{version.id}")
    else:
        params = eval_params(session, settings, version)
        enqueue(session, JobKind.EVAL, params, minibrain.id, version.id, f"eval:{version.id}")
    session.commit()
    return version_info(minibrain, version)


@router.delete("/minibrains/{slug}/versions/{number}", status_code=204, dependencies=[Depends(builder)])
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
            actor=current_actor(),
            action="version.delete",
            target=f"{slug}@{number}",
            detail={"name": minibrain.name, "kind": version.kind, "status": version.status},
        )
    )
    session.delete(version)
    session.flush()
    cleanup(session, settings)
    session.commit()


@router.post("/minibrains/{slug}/versions/{number}/promote", dependencies=[Depends(builder)])
def promote_version(slug: str, number: int, session: SessionDep, settings: SettingsDep) -> MinibrainDetail:
    minibrain = get_minibrain(session, slug)
    version = get_version(minibrain, number)
    mismatch = base_changed(
        f"{slug}@{number}", minibrain.base_model, version.base_hash, base_hash(session, minibrain.base_model)
    )
    if mismatch is not None:
        raise ConflictError(mismatch)
    previous, was_deployed = minibrain.current_version, minibrain.deployed
    cancel_stop(session, minibrain.teardown, minibrain.name)
    promote(minibrain, version)
    if (previous, was_deployed) != (number, True):
        audit_version(
            session, minibrain, number=number, action="version.promote", previous=previous, was_deployed=was_deployed
        )
    session.commit()
    return detail(settings, minibrain)


@router.post("/minibrains/{slug}/complete", dependencies=[Depends(viewer)])
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
    touch(session, minibrain.base_model)
    session.commit()
    return CompleteResponse(
        id=response_id(),
        model=f"{route.slug}@{route.version}",
        output=completion.text,
        label=parse_label(completion.text, route.labels),
        latency_ms=completion.seconds * 1000,
        prompt_tokens=completion.prompt_tokens,
        completion_tokens=completion.completion_tokens,
    )
