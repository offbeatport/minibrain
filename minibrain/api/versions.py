from typing import Any

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from minibrain.api.access import builder, sees_rows, viewer
from minibrain.api.deps import BackendDep, LocalNodeDep, SessionDep, SettingsDep, StoreDep
from minibrain.api.schemas import (
    CompleteRequest,
    CompleteResponse,
    MinibrainDetail,
    ScoreInfo,
    VersionCreate,
    VersionInfo,
    VersionTest,
    VersionTestResult,
)
from minibrain.api.training_plan import refuse, require_trainable, training_plan
from minibrain.api.views import detail, version_info
from minibrain.artifacts import ArtifactStore
from minibrain.auth.identity import current_actor
from minibrain.data.snapshots import cleanup, require_splits, training_snapshot
from minibrain.gateway.config import GatewayConfig, Route
from minibrain.gateway.routes import OpenAIError, conformed, prompting, response_id, run
from minibrain.jobs.queue import enqueue
from minibrain.jobs.specs import eval_params, train_params
from minibrain.ml.completion import Completion
from minibrain.models.health import base_changed
from minibrain.models.registry import base_hash, base_readiness, require_usable
from minibrain.models.usage import touch
from minibrain.presets import presets
from minibrain.registry.models import (
    ACTIVE_JOB_STATUSES,
    AuditEvent,
    JobKind,
    Minibrain,
    Model,
    Snapshot,
    Version,
    VersionKind,
    VersionStatus,
    now,
)
from minibrain.registry.prices import load_prices
from minibrain.registry.service import ConflictError, get_minibrain, get_version
from minibrain.serve.backend import ServingBackend
from minibrain.settings import Settings
from minibrain.tasks.contracts import answer_of
from minibrain.tasks.examples import Example, turns_of
from minibrain.tasks.graders import GraderError
from minibrain.tasks.service import decision, graders_of, new_version, version_contract
from minibrain.teardown import cancel_stop, require_idle

router = APIRouter(prefix="/api", tags=["versions"])

DEFAULT_ANSWER_TOKENS = 256
ANSWER_TOKENS = {key: item.answer_tokens for key, item in presets().items()}


def audit_version(session: Session, minibrain: Minibrain, number: int, action: str, **detail: Any) -> None:
    target = f"{minibrain.slug}@{number}"
    session.add(
        AuditEvent(actor=current_actor(), action=action, target=target, detail={"name": minibrain.name, **detail})
    )


def start_version(
    session: Session,
    settings: Settings,
    store: ArtifactStore,
    minibrain: Minibrain,
    kind: VersionKind,
    snapshot: Snapshot | None,
    recipe: dict[str, Any] | None = None,
    breaking: bool = False,
) -> Version:
    version = new_version(session, store, minibrain, kind, snapshot, recipe, breaking)
    audit_version(
        session,
        minibrain,
        number=version.number,
        action="version.create",
        kind=str(kind),
        snapshot=snapshot.hash if snapshot is not None else None,
        recipe=dict(version.recipe),
        contract=version.contract_number,
    )
    if kind == VersionKind.LORA:
        version.base_hash = base_hash(session, minibrain.base_model)
        params = train_params(session, settings, version)
        enqueue(session, JobKind.TRAIN, params, minibrain.id, version.id, f"train:{version.id}")
    elif version.status == VersionStatus.EVALUATING:
        if base_readiness(session, minibrain.base_model) != "ready":
            version.status = VersionStatus.READY
            return version
        params = eval_params(session, settings, version)
        enqueue(session, JobKind.EVAL, params, minibrain.id, version.id, f"eval:{version.id}")
    return version


@router.get("/minibrains/{slug}/versions", dependencies=[Depends(viewer)])
def list_versions(slug: str, session: SessionDep) -> list[VersionInfo]:
    minibrain = get_minibrain(session, slug)
    versions = sorted(minibrain.versions, key=lambda version: version.number, reverse=True)
    prices = load_prices(session)
    found = [version_info(minibrain, version, prices) for version in versions]
    return found if sees_rows() else [info.model_copy(update={"mistakes": []}) for info in found]


@router.post("/minibrains/{slug}/versions", status_code=201, dependencies=[Depends(builder)])
def add_version(
    slug: str,
    body: VersionCreate,
    session: SessionDep,
    settings: SettingsDep,
    store: StoreDep,
    node: LocalNodeDep,
) -> VersionInfo:
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
    if kind == VersionKind.LORA:
        require_trainable(session, settings, minibrain)
    snapshot = training_snapshot(session, settings, minibrain, body.snapshot_id)
    require_splits(snapshot)
    recipe: dict[str, Any] = {}
    if kind == VersionKind.LORA:
        found, _ = training_plan(session, settings, node, minibrain, snapshot, body)
        refuse(found)
        recipe = found.recipe()
    version = start_version(session, settings, store, minibrain, kind, snapshot, recipe, body.breaking)
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
    if version.status != VersionStatus.READY:
        raise ConflictError(f"{slug}@{number} is not ready")
    if version.live_at is None:
        found = decision(minibrain, version)
        if not found.passed:
            raise ConflictError(f"{slug}@{number} does not pass the promotion rule: {found.reason()}")
    previous, was_deployed = minibrain.current_version, minibrain.deployed
    cancel_stop(session, minibrain.teardown, minibrain.name)
    minibrain.current_version = version.number
    minibrain.deployed = True
    version.live_at = version.live_at or now()
    if (previous, was_deployed) != (number, True):
        audit_version(
            session, minibrain, number=number, action="version.promote", previous=previous, was_deployed=was_deployed
        )
    session.commit()
    return detail(settings, minibrain)


def routed(config: GatewayConfig, minibrain: Minibrain, number: int | None) -> Route:
    name = minibrain.slug if number is None else f"{minibrain.slug}@{number}"
    route = config.routes.get(name)
    if route is None:
        raise ConflictError("no ready version to run; score or train one first")
    return route


def answer_text(route: Route, output: str) -> tuple[str | None, bool]:
    found = prompting(route)
    if found is None:
        return output.strip(), True
    answer = answer_of(found.contract, output)
    shown = answer.value if isinstance(answer.value, str) or answer.value is None else output.strip()
    return shown, answer.valid


def answered(
    backend: ServingBackend, config: GatewayConfig, route: Route, messages: list[dict[str, str]], tokens: int | None
) -> Completion:
    found = prompting(route)
    budget = tokens or (DEFAULT_ANSWER_TOKENS if found is None else ANSWER_TOKENS.get(route.preset, 256))
    completion = run(backend, config, route, messages, budget)
    try:
        return conformed(None, completion, route)
    except OpenAIError:
        return completion


@router.post("/minibrains/{slug}/complete", dependencies=[Depends(viewer)])
def complete(
    slug: str, body: CompleteRequest, session: SessionDep, backend: BackendDep, request: Request
) -> CompleteResponse:
    minibrain = get_minibrain(session, slug)
    config = request.app.state.gateway_config.current()
    route = routed(config, minibrain, body.version)
    completion = answered(backend, config, route, [{"role": "user", "content": body.text}], body.max_tokens)
    touch(session, minibrain.base_model)
    session.commit()
    answer, valid = answer_text(route, completion.text)
    return CompleteResponse(
        id=response_id(),
        model=f"{route.slug}@{route.version}",
        output=completion.text,
        answer=answer,
        valid=valid,
        contract=route.contract,
        latency_ms=completion.seconds * 1000,
        prompt_tokens=completion.prompt_tokens,
        completion_tokens=completion.completion_tokens,
    )


def test_scores(version: Version, output: str, expected: str | None, messages: list[dict[str, str]]) -> list[ScoreInfo]:
    turns = turns_of(messages)
    if expected is None or not turns:
        return []
    example = Example(turns=turns, expected=expected.strip())
    try:
        graders = graders_of(version)
    except GraderError:
        return []
    return [
        ScoreInfo(grader=grader.name, version=grader.version, metric=metric, value=value)
        for grader in graders
        for metric, value in grader.score(output, example).items()
    ]


@router.post("/minibrains/{slug}/versions/{number}/test", dependencies=[Depends(viewer)])
def test_version(
    slug: str, number: int, body: VersionTest, session: SessionDep, backend: BackendDep, request: Request
) -> VersionTestResult:
    minibrain = get_minibrain(session, slug)
    version = get_version(minibrain, number)
    config = request.app.state.gateway_config.current()
    route = routed(config, minibrain, number)
    messages = [message.model_dump() for message in body.messages]
    completion = answered(backend, config, route, messages, body.max_tokens)
    touch(session, minibrain.base_model)
    session.commit()
    answer = answer_of(version_contract(version), completion.text)
    shown, _ = answer_text(route, completion.text)
    return VersionTestResult(
        output=completion.text,
        answer=shown,
        valid=answer.valid,
        scores=test_scores(version, completion.text, body.expected, messages),
        latency_ms=completion.seconds * 1000,
        prompt_tokens=completion.prompt_tokens,
        completion_tokens=completion.completion_tokens,
    )
