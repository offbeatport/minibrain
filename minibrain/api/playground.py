from dataclasses import replace
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.api.access import viewer
from minibrain.api.deps import SessionDep, SettingsDep
from minibrain.api.safety import guards
from minibrain.api.schemas import GuardInfo
from minibrain.auth.identity import current_actor, current_person
from minibrain.base_models import BaseModelSpec
from minibrain.gateway.chat import (
    answer,
    chat_events,
    checked_base,
    plan,
    response_body,
    response_id,
    route_contract,
    safety_of,
    served_model,
    sse,
)
from minibrain.gateway.config import GatewayConfig, Route, base_route_for
from minibrain.gateway.safety import Verdict
from minibrain.gateway.schema import CHAT_RESPONSES, ChatCompletionRequest
from minibrain.ml.completion import Completion
from minibrain.models.registry import base_config, base_publisher, require_usable, spec_for
from minibrain.models.safety import install_safety
from minibrain.models.usage import touch
from minibrain.registry.models import AuditEvent, BaseModelStatus, CatalogModel, Model, PlaygroundPreset, now
from minibrain.registry.models import BaseModel as BaseRow
from minibrain.registry.service import ConflictError, NotFoundError
from minibrain.serve.backend import AdapterRef
from minibrain.serve.dialects import detect_guard, reasoning_choices
from minibrain.settings import Settings
from minibrain.tasks.contracts import JSON, Contract

router = APIRouter(prefix="/api/playground", tags=["playground"])

ContractKind = Literal["text", "labels", "json"]
CHAT_HELP = (
    "The Playground's chat: the same body, answer and stream as POST /v1/chat/completions, with the signed-in "
    "person instead of an API key. It also reaches installed bases that are not deployed. Calls are not request "
    "logs; a safety block is audited with the person as actor."
)


class PlaygroundTarget(BaseModel):
    name: str = Field(description="What to send as model.")
    kind: Literal["custom", "base"]
    key: str = Field(description="The custom model's slug or the base model's key.")
    model_name: str
    publisher: str | None = Field(description="Who published the base, for its logo; none for custom models.")
    version: int | None
    live: bool = Field(description="The name follows the live version.")
    deployed: bool
    base: str
    contract: ContractKind
    labels: list[str]
    tools: str | None = Field(description="The tool-call format, when the base has one.")
    reasoning: str | None = Field(description="toggle, effort or always, when the base reasons.")
    reasoning_choices: list[str]
    context_tokens: int | None
    safety: str | None = Field(description="The safety model that always checks this target.")
    safety_answers: bool


class PlaygroundModels(BaseModel):
    targets: list[PlaygroundTarget]
    guards: list[GuardInfo]


class SavedPresetBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    settings: dict[str, Any] = Field(default_factory=dict)
    is_default: bool = False


class SavedPresetUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    settings: dict[str, Any] | None = None
    is_default: bool | None = None


class SavedPresetInfo(BaseModel):
    id: int
    name: str
    settings: dict[str, Any]
    is_default: bool


class BaseFacts(BaseModel):
    name: str
    spec: dict[str, Any]
    context: int | None
    publisher: str | None = None


def contract_kind(contract: Contract | None) -> tuple[ContractKind, list[str]]:
    if contract is None or contract.kind != JSON:
        return "text", []
    labels = contract.labels
    return ("labels", list(labels)) if labels is not None else ("json", [])


def context_of(session: Session, settings: Settings, base: BaseRow) -> int | None:
    catalogue = session.get(CatalogModel, base.catalog_id) if base.catalog_id else None
    if catalogue is not None and catalogue.context_tokens:
        return catalogue.context_tokens
    value = (base_config(settings, base) or {}).get("max_position_embeddings")
    return value if isinstance(value, int) else None


def target(
    name: str, kind: Literal["custom", "base"], key: str, model_name: str, facts: BaseFacts, route: Route
) -> PlaygroundTarget:
    spec = BaseModelSpec.from_dict(facts.spec)
    contract, labels = contract_kind(route_contract(route))
    safety = route.safety or {}
    return PlaygroundTarget(
        name=name,
        kind=kind,
        key=key,
        model_name=model_name,
        publisher=facts.publisher if kind == "base" else None,
        version=route.version,
        live=kind == "custom" and "@" not in name,
        deployed="@" not in name,
        base=route.base_model,
        contract=contract,
        labels=labels,
        tools=spec.tools,
        reasoning=spec.reasoning,
        reasoning_choices=list(reasoning_choices(spec.reasoning)),
        context_tokens=facts.context,
        safety=safety.get("model"),
        safety_answers=bool(safety.get("answers")),
    )


def playground_models(session: Session, settings: Settings, config: GatewayConfig) -> PlaygroundModels:
    names = {model.slug: model.name for model in session.scalars(select(Model))}
    available = select(BaseRow).where(BaseRow.status == BaseModelStatus.AVAILABLE).order_by(BaseRow.name)
    facts: dict[str, BaseFacts] = {}
    for base in session.scalars(available):
        context = context_of(session, settings, base)
        spec = spec_for(settings, base).as_dict()
        facts[base.id] = BaseFacts(name=base.name, spec=spec, context=context, publisher=base_publisher(base))
    served = {key: BaseFacts(name=key, spec=spec, context=None) for key, spec in config.bases.items()}
    known = served | facts
    custom = [
        target(name, "custom", route.slug, names.get(route.slug, route.slug), known[route.base_model], route)
        for name, route in sorted(config.routes.items())
        if route.model_id is not None and route.base_model in known
    ]
    install = install_safety(session).as_route()
    bases = [
        target(key, "base", key, found.name, found, replace(base_route_for(key), safety=install))
        for key, found in facts.items()
        if not BaseModelSpec.from_dict(found.spec).guard
    ]
    deployed = {key for key, route in config.routes.items() if route.model_id is None}
    bases = [found.model_copy(update={"deployed": found.key in deployed}) for found in bases]
    return PlaygroundModels(targets=custom + bases, guards=guards(session))


@router.get("/models", dependencies=[Depends(viewer)])
def list_targets(request: Request, session: SessionDep, settings: SettingsDep) -> PlaygroundModels:
    return playground_models(session, settings, request.app.state.gateway_config.current())


def playground_route(
    session: Session, settings: Settings, config: GatewayConfig, name: str
) -> tuple[Route, BaseModelSpec, AdapterRef | None]:
    route = config.routes.get(name)
    if route is not None:
        base, adapter = checked_base(config, route)
        return route, base, adapter
    row = session.get(BaseRow, name)
    if row is None or row.status != BaseModelStatus.AVAILABLE or detect_guard(row.repo, row.name):
        raise HTTPException(status_code=404, detail=f"model {name} not found")
    try:
        require_usable(session, settings, name)
    except (ConflictError, NotFoundError) as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    chosen = replace(base_route_for(name), safety=install_safety(session).as_route())
    return chosen, spec_for(settings, row), None


def audit_block(request: Request, actor: str, route: Route, identifier: str, verdict: Verdict | None) -> None:
    if verdict is None or verdict.safe:
        return
    detail = {
        "safety_model": verdict.model,
        "stage": verdict.stage,
        "categories": list(verdict.categories),
        "response_id": identifier,
        "playground": True,
    }
    with request.app.state.sessions() as session:
        session.add(AuditEvent(actor=actor, action="safety.block", target=served_model(route), detail=detail))
        session.commit()


@router.post(
    "/chat/completions",
    dependencies=[Depends(viewer)],
    response_model=None,
    summary="Chat in the Playground",
    description=CHAT_HELP,
    responses=CHAT_RESPONSES,
)
def playground_chat(
    body: ChatCompletionRequest, request: Request, session: SessionDep, settings: SettingsDep
) -> dict[str, Any] | StreamingResponse:
    config: GatewayConfig = request.app.state.gateway_config.current()
    route, base, adapter = playground_route(session, settings, config, body.model)
    chat = plan(body, route, base, adapter, safety_of(body, route, config))
    touch(session, route.base_model)
    session.commit()
    actor = current_actor()
    identifier = response_id()
    backend = request.app.state.backend

    def finished(_completion: Completion | None, _error: BaseException | None) -> None:
        audit_block(request, actor, route, identifier, chat.verdict)

    if body.stream:
        events = chat_events(backend, chat)
        stream = sse(identifier, body.model, next(events), events, True, finished)
        return StreamingResponse(stream, media_type="text/event-stream")
    completion = answer(backend, chat)
    finished(completion, None)
    return response_body(identifier, body.model, completion, chat.verdict)


def owner_id() -> int:
    person = current_person()
    if person is None:
        raise HTTPException(status_code=401, detail="sign in first")
    return person.id


def preset_info(preset: PlaygroundPreset) -> SavedPresetInfo:
    return SavedPresetInfo(id=preset.id, name=preset.name, settings=dict(preset.settings), is_default=preset.is_default)


def own_presets(session: Session, user_id: int) -> list[PlaygroundPreset]:
    query = select(PlaygroundPreset).where(PlaygroundPreset.user_id == user_id).order_by(PlaygroundPreset.name)
    return list(session.scalars(query))


def own_preset(session: Session, preset_id: int) -> PlaygroundPreset:
    preset = session.get(PlaygroundPreset, preset_id)
    if preset is None or preset.user_id != owner_id():
        raise HTTPException(status_code=404, detail="no such preset")
    return preset


def name_free(session: Session, user_id: int, name: str, keep: int | None = None) -> None:
    for preset in own_presets(session, user_id):
        if preset.name.casefold() == name.casefold() and preset.id != keep:
            raise ConflictError(f"you already have a preset named {name}")


def make_default(session: Session, chosen: PlaygroundPreset) -> None:
    for preset in own_presets(session, chosen.user_id):
        preset.is_default = preset.id == chosen.id


@router.get("/presets", dependencies=[Depends(viewer)])
def list_presets(session: SessionDep) -> list[SavedPresetInfo]:
    return [preset_info(preset) for preset in own_presets(session, owner_id())]


@router.post("/presets", status_code=201, dependencies=[Depends(viewer)])
def create_preset(body: SavedPresetBody, session: SessionDep) -> SavedPresetInfo:
    user_id = owner_id()
    name = body.name.strip()
    name_free(session, user_id, name)
    preset = PlaygroundPreset(user_id=user_id, name=name, settings=body.settings, is_default=False)
    session.add(preset)
    session.flush()
    if body.is_default:
        make_default(session, preset)
    session.commit()
    return preset_info(preset)


@router.put("/presets/{preset_id}", dependencies=[Depends(viewer)])
def update_preset(preset_id: int, body: SavedPresetUpdate, session: SessionDep) -> SavedPresetInfo:
    preset = own_preset(session, preset_id)
    if body.name is not None:
        name_free(session, preset.user_id, body.name.strip(), keep=preset.id)
        preset.name = body.name.strip()
    if body.settings is not None:
        preset.settings = body.settings
    if body.is_default is True:
        make_default(session, preset)
    elif body.is_default is False:
        preset.is_default = False
    preset.updated_at = now()
    session.commit()
    return preset_info(preset)


@router.delete("/presets/{preset_id}", status_code=204, dependencies=[Depends(viewer)])
def delete_preset(preset_id: int, session: SessionDep) -> None:
    session.delete(own_preset(session, preset_id))
    session.commit()
