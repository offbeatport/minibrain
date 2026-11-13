from typing import Any

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from minibrain.api.access import builder, sees_rows, viewer
from minibrain.api.deps import BackendDep, LocalNodeDep, QueueDep, SessionDep, SettingsDep, StoreDep
from minibrain.api.jobs import canceller
from minibrain.api.schemas import (
    AnswerSide,
    ExampleAnswer,
    ModelDetail,
    PackedFileInfo,
    ScoreInfo,
    TurnInfo,
    VersionAnswers,
    VersionCreate,
    VersionFiles,
    VersionInfo,
    VersionTest,
    VersionTestResult,
)
from minibrain.api.training_plan import refuse, require_trainable, training_plan
from minibrain.api.views import detail, version_info
from minibrain.artifacts import ArtifactStore
from minibrain.auth.identity import current_actor
from minibrain.data.dataset_versions import require_splits, training_dataset_version
from minibrain.gateway.chat import conformed, prompting, run
from minibrain.gateway.config import GatewayConfig, Route
from minibrain.gateway.errors import OpenAIError
from minibrain.jobs.queue import enqueue
from minibrain.jobs.specs import eval_params, train_params
from minibrain.ml.completion import Completion
from minibrain.ml.planner import Plan
from minibrain.models.health import base_changed
from minibrain.models.registry import base_hash, base_readiness, require_usable
from minibrain.models.usage import touch
from minibrain.presets import presets
from minibrain.registry.files import packed_files
from minibrain.registry.models import (
    Artifact,
    AuditEvent,
    BaseModel,
    DatasetVersion,
    JobKind,
    Model,
    Version,
    VersionKind,
    VersionStatus,
    now,
)
from minibrain.registry.prices import load_prices
from minibrain.registry.service import ConflictError, get_model, get_version, latest_dataset_version
from minibrain.serve.backend import ServingBackend
from minibrain.settings import Settings
from minibrain.tasks.answers import Side, compared
from minibrain.tasks.contracts import answer_of
from minibrain.tasks.examples import Example, turns_of
from minibrain.tasks.graders import GraderError
from minibrain.tasks.rebase import other_base
from minibrain.tasks.service import decision, graders_of, new_version, version_contract
from minibrain.teardown import (
    a_job_running,
    cancel_stop,
    remove_version,
    require_idle,
    stop_jobs,
    uncancelled,
    version_jobs,
)

router = APIRouter(prefix="/api")

DEFAULT_ANSWER_TOKENS = 256
ANSWER_TOKENS = {key: item.answer_tokens for key, item in presets().items()}


def audit_version(session: Session, model: Model, number: int, action: str, **detail: Any) -> None:
    target = f"{model.slug}@{number}"
    session.add(AuditEvent(actor=current_actor(), action=action, target=target, detail={"name": model.name, **detail}))


def start_version(
    session: Session,
    settings: Settings,
    store: ArtifactStore,
    model: Model,
    kind: VersionKind,
    dataset_version: DatasetVersion | None,
    recipe: dict[str, Any] | None = None,
    breaking: bool = False,
    pool: str | None = None,
) -> Version:
    version = new_version(session, store, model, kind, dataset_version, recipe, breaking)
    audit_version(
        session,
        model,
        number=version.number,
        action="version.create",
        kind=str(kind),
        dataset_version=dataset_version.hash if dataset_version is not None else None,
        recipe=dict(version.recipe),
        contract=version.contract_number,
    )
    if kind == VersionKind.LORA:
        version.base_hash = base_hash(session, version.base_model)
        params = train_params(session, settings, version)
        enqueue(session, JobKind.TRAIN, params, model.id, version.id, f"train:{version.id}", pool=pool)
    elif version.status == VersionStatus.EVALUATING:
        if base_readiness(session, version.base_model) != "ready":
            version.status = VersionStatus.READY
            return version
        params = eval_params(session, settings, version)
        enqueue(session, JobKind.EVAL, params, model.id, version.id, f"eval:{version.id}")
    return version


def job_pool(body: VersionCreate, found: Plan) -> str | None:
    if body.pool is not None:
        return body.pool
    if body.machine is not None and found.machine is not None:
        return found.machine.pool
    return None


def save_instructions(session: Session, model: Model, instructions: str | None) -> None:
    if instructions is None:
        return
    wanted = instructions.strip() or None
    if wanted == model.instructions:
        return
    model.instructions = wanted
    model.updated_at = now()
    session.add(
        AuditEvent(actor=current_actor(), action="model.instructions", target=model.slug, detail={"name": model.name})
    )


def needs_no_data(model: Model, body: VersionCreate) -> bool:
    return body.dataset_version_id is None and latest_dataset_version(model) is None


@router.get("/models/{name}/versions", dependencies=[Depends(viewer)], summary="List a custom model's versions")
def list_versions(name: str, session: SessionDep) -> list[VersionInfo]:
    model = get_model(session, name)
    versions = sorted(model.versions, key=lambda version: version.number, reverse=True)
    prices = load_prices(session)
    found = [version_info(model, version, prices) for version in versions]
    return found if sees_rows() else [info.model_copy(update={"mistakes": []}) for info in found]


@router.get("/models/{name}/versions/{number}/files", dependencies=[Depends(viewer)], summary="List a version's files")
def version_files(name: str, number: int, session: SessionDep, store: StoreDep) -> VersionFiles:
    version = get_version(get_model(session, name), number)
    artifact = session.get(Artifact, version.adapter_artifact_id) if version.adapter_artifact_id else None
    if artifact is None:
        return VersionFiles(number=number, artifact_id=version.adapter_artifact_id, size=None, files=[])
    packed = packed_files(store, artifact)
    files = [PackedFileInfo(path=item.path, size=item.size, sha256=item.sha256) for item in packed]
    return VersionFiles(number=number, artifact_id=artifact.id, size=artifact.size, files=files)


def answer_side(side: Side | None) -> AnswerSide | None:
    return None if side is None else AnswerSide(answer=side.answer, scores=side.scores, reason=side.reason)


@router.get(
    "/models/{name}/versions/{number}/answers",
    dependencies=[Depends(builder)],
    summary="List the answers a version was scored on",
)
def version_answers(
    name: str, number: int, session: SessionDep, store: StoreDep, against: int | None = None
) -> VersionAnswers:
    model = get_model(session, name)
    other = get_version(model, against) if against is not None else None
    found = compared(session, store, model, get_version(model, number), other)
    return VersionAnswers(
        number=found.number,
        live=found.live,
        metric=found.metric,
        examples=[
            ExampleAnswer(
                messages=[TurnInfo(role=turn.role, content=turn.content) for turn in row.example.turns],
                expected=row.example.expected,
                version=AnswerSide(answer=row.mine.answer, scores=row.mine.scores, reason=row.mine.reason),
                live=answer_side(row.live),
                worse=row.worse,
            )
            for row in found.rows
        ],
    )


@router.post(
    "/models/{name}/versions",
    status_code=201,
    dependencies=[Depends(builder)],
    summary="Add a version: prompt-only or trained",
)
def add_version(
    name: str,
    body: VersionCreate,
    session: SessionDep,
    settings: SettingsDep,
    store: StoreDep,
    node: LocalNodeDep,
) -> VersionInfo:
    model = get_model(session, name)
    require_idle(model.teardown, model.name)
    base = session.get(BaseModel, model.base_model)
    if base is not None:
        require_idle(base.teardown, base.name)
    kind = VersionKind(body.kind)
    readiness = base_readiness(session, model.base_model)
    if readiness == "pending":
        raise ConflictError(f"{model.base_model} is still being imported or downloaded; try once it is available")
    if readiness == "missing":
        raise ConflictError(f"{model.base_model} is no longer on this install")
    require_usable(session, settings, model.base_model)
    if kind == VersionKind.LORA:
        require_trainable(session, settings, model)
    save_instructions(session, model, body.instructions)
    if kind == VersionKind.PROMPT and needs_no_data(model, body):
        version = start_version(session, settings, store, model, kind, None, {}, body.breaking)
        session.commit()
        return version_info(model, version)
    dataset_version = training_dataset_version(session, settings, model, body.dataset_version_id)
    require_splits(dataset_version)
    recipe: dict[str, Any] = {}
    pool: str | None = None
    if kind == VersionKind.LORA:
        found, _ = training_plan(session, settings, node, model, dataset_version, body)
        refuse(found)
        recipe = found.recipe()
        pool = job_pool(body, found)
    version = start_version(session, settings, store, model, kind, dataset_version, recipe, body.breaking, pool)
    session.commit()
    return version_info(model, version)


@router.delete(
    "/models/{name}/versions/{number}",
    status_code=204,
    response_model=None,
    responses={202: {"model": VersionInfo, "description": "Its cancelled jobs are stopping; it goes once they end"}},
    dependencies=[Depends(builder)],
    summary="Delete a version",
)
def delete_version(
    name: str,
    number: int,
    request: Request,
    session: SessionDep,
    settings: SettingsDep,
    queue: QueueDep,
    cancel_jobs: bool = False,
) -> Response:
    model = get_model(session, name)
    version = get_version(model, number)
    jobs = version_jobs(session, version)
    refusal = a_job_running(f"{name}@{number}", uncancelled(jobs))
    cancel = canceller(session, queue, cancel_jobs)
    if version.status == VersionStatus.DELETING:
        if cancel is not None:
            stop_jobs(jobs, cancel, refusal)
            session.commit()
        return deleting(model, version)
    if model.deployed and model.current_version == number:
        raise ConflictError(f"{name}@{number} is deployed; undeploy it first")
    stop_jobs(jobs, cancel, refusal)
    if model.current_version == number:
        model.current_version = None
    facts: dict[str, Any] = {"name": model.name, "kind": version.kind, "status": version.status}
    if jobs:
        facts["jobs"] = [job.id for job in jobs]
    session.add(AuditEvent(actor=current_actor(), action="version.delete", target=f"{name}@{number}", detail=facts))
    if version_jobs(session, version):
        version.status = VersionStatus.DELETING
        session.commit()
        request.app.state.teardowns.wake()
        return deleting(model, version)
    remove_version(session, settings, version)
    session.commit()
    return Response(status_code=204)


def deleting(model: Model, version: Version) -> JSONResponse:
    return JSONResponse(status_code=202, content=version_info(model, version).model_dump(mode="json"))


@router.post("/models/{name}/versions/{number}/promote", dependencies=[Depends(builder)], summary="Make a version live")
def promote_version(name: str, number: int, session: SessionDep, settings: SettingsDep) -> ModelDetail:
    model = get_model(session, name)
    version = get_version(model, number)
    already = model.deployed and model.current_version == number
    refusal = other_base(session, model, version)
    if refusal is not None and not already:
        raise ConflictError(refusal)
    mismatch = base_changed(
        f"{name}@{number}", version.base_model, version.base_hash, base_hash(session, version.base_model)
    )
    if mismatch is not None:
        raise ConflictError(mismatch)
    if version.status != VersionStatus.READY:
        raise ConflictError(f"{name}@{number} is not ready")
    if version.live_at is None:
        found = decision(model, version)
        if not found.passed:
            raise ConflictError(f"{name}@{number} does not pass the promotion rule: {found.reason()}")
    previous, was_deployed = model.current_version, model.deployed
    cancel_stop(session, model.teardown, model.name)
    model.current_version = version.number
    model.deployed_base = model.deployed_base if was_deployed else model.base_model
    model.deployed = True
    version.live_at = version.live_at or now()
    model.first_live_at = model.first_live_at or version.live_at
    if (previous, was_deployed) != (number, True):
        audit_version(
            session, model, number=number, action="version.promote", previous=previous, was_deployed=was_deployed
        )
    session.commit()
    return detail(settings, model)


def routed(config: GatewayConfig, model: Model, number: int | None) -> Route:
    name = model.slug if number is None else f"{model.slug}@{number}"
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


@router.post(
    "/models/{name}/versions/{number}/test", dependencies=[Depends(viewer)], summary="Send a prompt to a version"
)
def test_version(
    name: str, number: int, body: VersionTest, session: SessionDep, backend: BackendDep, request: Request
) -> VersionTestResult:
    model = get_model(session, name)
    version = get_version(model, number)
    config = request.app.state.gateway_config.current()
    route = routed(config, model, number)
    messages = [message.model_dump() for message in body.messages]
    completion = answered(backend, config, route, messages, body.max_tokens)
    touch(session, version.base_model)
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
