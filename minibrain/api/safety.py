from fastapi import APIRouter, Depends

from minibrain.api.access import admin, builder, viewer
from minibrain.api.deps import SessionDep, SettingsDep
from minibrain.api.schemas import GuardInfo, ModelDetail, ModelSafetyUpdate, SafetySetting, SafetyUpdate
from minibrain.api.views import base_name, detail
from minibrain.auth.identity import current_actor
from minibrain.models.safety import guard_keys, install_safety, override_of, require_guard, set_install_safety
from minibrain.registry.models import AuditEvent, BaseModel, now
from minibrain.registry.service import get_model
from minibrain.serve.dialects import detect_guard

router = APIRouter(prefix="/api")


def guards(session: SessionDep) -> list[GuardInfo]:
    found: list[GuardInfo] = []
    for key in guard_keys(session):
        base = session.get(BaseModel, key)
        kind = detect_guard(base.repo, base.name) if base is not None else None
        found.append(GuardInfo(key=key, name=base_name(session, key), kind=kind or ""))
    return found


def safety_setting(session: SessionDep) -> SafetySetting:
    chosen = install_safety(session)
    name = base_name(session, chosen.model) if chosen.model else None
    return SafetySetting(model=chosen.model, name=name, answers=chosen.answers, guards=guards(session))


@router.get("/settings/safety", dependencies=[Depends(viewer)], summary="Read the default safety model")
def read_safety(session: SessionDep) -> SafetySetting:
    return safety_setting(session)


@router.put("/settings/safety", dependencies=[Depends(admin)], summary="Change the default safety model")
def update_safety(body: SafetyUpdate, session: SessionDep) -> SafetySetting:
    before = install_safety(session)
    set_install_safety(session, body.model, body.answers)
    facts = {"from": before.model, "to": body.model or None, "answers": body.answers}
    session.add(AuditEvent(actor=current_actor(), action="settings.safety", target="safety", detail=facts))
    session.commit()
    return safety_setting(session)


@router.put("/models/{name}/safety", dependencies=[Depends(builder)], summary="Change a custom model's safety model")
def update_model_safety(name: str, body: ModelSafetyUpdate, session: SessionDep, settings: SettingsDep) -> ModelDetail:
    model = get_model(session, name)
    if body.mode == "model" and body.model:
        require_guard(session, body.model)
    before = model.safety
    model.safety = override_of(body.mode, body.model, body.answers)
    model.updated_at = now()
    facts = {"name": model.name, "from": before, "to": model.safety}
    session.add(AuditEvent(actor=current_actor(), action="model.safety", target=name, detail=facts))
    session.commit()
    return detail(settings, model)
