from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from minibrain.api.access import builder, viewer
from minibrain.api.deps import SessionDep, SettingsDep, StoreDep
from minibrain.api.models import first_version
from minibrain.api.schemas import BaseChoice, BaseOptions, BaseSwitch, ModelDetail
from minibrain.api.views import detail, target_info
from minibrain.auth.identity import current_actor
from minibrain.models.registry import base_readiness, require_usable
from minibrain.registry.models import AuditEvent, Model, now
from minibrain.registry.service import ConflictError, get_model
from minibrain.settings import Settings
from minibrain.tasks.rebase import (
    base_name,
    installed_keys,
    lost_features,
    quantized_format,
    require_switchable,
    trainable_target,
)
from minibrain.tasks.service import live_version, serving_base
from minibrain.teardown import require_idle

router = APIRouter(prefix="/api/models")


def choice(session: Session, settings: Settings, model: Model, key: str) -> BaseChoice | None:
    readiness = base_readiness(session, key)
    if readiness == "missing":
        return None
    refusal = None
    if key != model.base_model:
        try:
            require_switchable(session, model, key)
        except ConflictError as error:
            refusal = str(error)
    found = quantized_format(session, settings, key)
    return BaseChoice(
        key=key,
        name=base_name(session, key),
        state="ready" if readiness == "ready" else "pending",
        current=key == model.base_model,
        serve_only=found.upper() if found else None,
        warnings=lost_features(session, settings, model, key) if key != model.base_model else [],
        refusal=refusal,
    )


@router.get(
    "/{name}/base-options",
    dependencies=[Depends(viewer)],
    summary="List the bases a custom model can move to",
    description="Installed bases with what the model would lose on each, and the full-precision variant to download.",
)
def base_options(name: str, session: SessionDep, settings: SettingsDep) -> BaseOptions:
    model = get_model(session, name)
    choices = [choice(session, settings, model, key) for key in installed_keys(session)]
    return BaseOptions(
        current=model.base_model,
        choices=[item for item in choices if item is not None],
        switch_to=target_info(trainable_target(session, model.base_model)),
    )


@router.post(
    "/{name}/base",
    dependencies=[Depends(builder)],
    summary="Move a custom model to another base",
    description=(
        "New versions are made on the new base, starting with a prompt-only version scored at once. "
        "What is live keeps serving on its own base until a version on the new base is deployed."
    ),
)
def switch_base(
    name: str, body: BaseSwitch, session: SessionDep, settings: SettingsDep, store: StoreDep
) -> ModelDetail:
    model = get_model(session, name)
    require_idle(model.teardown, model.name)
    require_switchable(session, model, body.base_model)
    require_usable(session, settings, body.base_model)
    old = model.base_model
    live = live_version(model)
    serving = serving_base(model) if model.deployed else None
    model.base_model = body.base_model
    model.updated_at = now()
    first_version(session, settings, store, model)
    facts = {
        "name": model.name,
        "from": old,
        "to": body.base_model,
        "version": max(version.number for version in model.versions),
        "live": live.number if live is not None else None,
        "serving": serving,
    }
    session.add(AuditEvent(actor=current_actor(), action="model.base_change", target=model.slug, detail=facts))
    session.commit()
    return detail(settings, model)
