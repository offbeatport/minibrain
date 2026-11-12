from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import Select, select
from sqlalchemy.orm import Session

from minibrain.api.access import builder
from minibrain.api.deps import SessionDep
from minibrain.api.schemas import KeyCreate, KeyCreated, KeyInfo, KeyScopeUpdate, ModelRef
from minibrain.api.views import key_info
from minibrain.auth.identity import current_actor, current_role
from minibrain.auth.roles import LABELS, Role, allows
from minibrain.registry.models import ApiKey, AuditEvent, BaseModel, Model
from minibrain.registry.service import (
    ConflictError,
    NotFoundError,
    create_key,
    get_model,
    key_expiry_limit,
    no_model,
    set_scopes,
)

router = APIRouter(prefix="/api/keys", tags=["keys"])

ALL_MODELS_NEEDS_ADMIN = f"A key for all models needs the {LABELS[Role.ADMIN]} role"


def resolve(session: Session, refs: list[ModelRef]) -> tuple[list[Model], list[str]]:
    models: dict[int, Model] = {}
    model_ids: list[str] = []
    for ref in refs:
        if ref.kind == "custom":
            model = get_model(session, ref.key)
            models[model.id] = model
        elif session.get(BaseModel, ref.key) is None:
            raise no_model(session, ref.key)
        else:
            model_ids.append(ref.key)
    return list(models.values()), model_ids


def name_clash(
    session: Session, name: str, models: list[Model], model_ids: list[str], all_models: bool = False
) -> str | None:
    wanted = name.strip().casefold()
    custom = {model.id: model.name for model in models}
    for key in session.scalars(select(ApiKey)):
        if key.name.strip().casefold() != wanted:
            continue
        if key.all_models:
            return "every model"
        if all_models:
            return first_model(session, key)
        for scope in key.scopes:
            if scope.model_id is not None and scope.model_id in custom:
                return custom[scope.model_id]
            if scope.base_model_id is not None and scope.base_model_id in model_ids:
                base = session.get(BaseModel, scope.base_model_id)
                return base.name if base is not None else scope.base_model_id
    return None


def first_model(session: Session, key: ApiKey) -> str:
    found = key_info(session, key).models
    return found[0].name if found else "no model"


def is_admin() -> bool:
    return allows(current_role(), Role.ADMIN)


def require_admin_for(all_models: bool) -> None:
    if all_models and not is_admin():
        raise HTTPException(status_code=403, detail=ALL_MODELS_NEEDS_ADMIN)


def visible_keys() -> Select[ApiKey]:
    query = select(ApiKey).order_by(ApiKey.id.desc())
    return query if is_admin() else query.where(ApiKey.created_by == current_actor())


def get_key(session: Session, key_id: int) -> ApiKey:
    key = session.get(ApiKey, key_id)
    if key is None or not (is_admin() or key.created_by == current_actor()):
        raise NotFoundError(f"key {key_id} not found")
    return key


def audit(session: Session, action: str, key: ApiKey) -> None:
    models = [model.key for model in key_info(session, key).models]
    detail = {"name": key.name, "scope": "all" if key.all_models else "models", "models": models}
    session.add(AuditEvent(actor=current_actor(), action=action, target=key.prefix, detail=detail))


def expiry_days(session: Session, wanted: int | None) -> int | None:
    limit = key_expiry_limit(session)
    if wanted is not None and limit and wanted > limit:
        raise HTTPException(status_code=422, detail=f"Keys on this install expire within {limit} days.")
    return wanted


@router.get("", dependencies=[Depends(builder)])
def list_keys(session: SessionDep) -> list[KeyInfo]:
    return [key_info(session, key) for key in session.scalars(visible_keys())]


@router.post("", status_code=201, dependencies=[Depends(builder)])
def add_key(body: KeyCreate, session: SessionDep) -> KeyCreated:
    require_admin_for(body.all_models)
    models, model_ids = resolve(session, body.models)
    taken = name_clash(session, body.name, models, model_ids, body.all_models)
    if taken is not None:
        raise ConflictError(f"A key called {body.name} already calls {taken}.")
    days = expiry_days(session, body.expires_in_days)
    key, secret = create_key(session, body.name, models, model_ids, all_models=body.all_models, days=days)
    key.created_by = current_actor()
    audit(session, "key.create", key)
    session.commit()
    return KeyCreated(secret=secret, **key_info(session, key).model_dump())


@router.put("/{key_id}/models", dependencies=[Depends(builder)])
def update_models(key_id: int, body: KeyScopeUpdate, session: SessionDep) -> KeyInfo:
    key = get_key(session, key_id)
    require_admin_for(body.all_models or key.all_models)
    models, model_ids = resolve(session, body.models)
    set_scopes(session, key, models, model_ids, all_models=body.all_models)
    audit(session, "key.update", key)
    session.commit()
    return key_info(session, key)


@router.delete("/{key_id}", status_code=204, dependencies=[Depends(builder)])
def revoke(key_id: int, session: SessionDep) -> None:
    key = get_key(session, key_id)
    audit(session, "key.revoke", key)
    session.delete(key)
    session.commit()
