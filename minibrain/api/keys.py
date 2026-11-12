from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.api.access import builder
from minibrain.api.deps import SessionDep
from minibrain.api.schemas import KeyCreate, KeyCreated, KeyInfo, KeyScopeUpdate, ModelRef
from minibrain.api.views import key_info
from minibrain.auth.identity import current_actor
from minibrain.registry.models import ApiKey, AuditEvent, BaseModel, Model
from minibrain.registry.service import ConflictError, NotFoundError, create_key, get_model, no_model, set_scopes

router = APIRouter(prefix="/api/keys", tags=["keys"])


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


def name_clash(session: Session, name: str, models: list[Model], model_ids: list[str]) -> str | None:
    wanted = name.strip().casefold()
    custom = {model.id: model.name for model in models}
    for key in session.scalars(select(ApiKey)):
        if key.name.strip().casefold() != wanted:
            continue
        for scope in key.scopes:
            if scope.model_id is not None and scope.model_id in custom:
                return custom[scope.model_id]
            if scope.base_model_id is not None and scope.base_model_id in model_ids:
                base = session.get(BaseModel, scope.base_model_id)
                return base.name if base is not None else scope.base_model_id
    return None


def get_key(session: Session, key_id: int) -> ApiKey:
    key = session.get(ApiKey, key_id)
    if key is None:
        raise NotFoundError(f"key {key_id} not found")
    return key


def audit(session: Session, action: str, key: ApiKey) -> None:
    models = [model.key for model in key_info(session, key).models]
    session.add(
        AuditEvent(actor=current_actor(), action=action, target=key.prefix, detail={"name": key.name, "models": models})
    )


@router.get("", dependencies=[Depends(builder)])
def list_keys(session: SessionDep) -> list[KeyInfo]:
    return [key_info(session, key) for key in session.scalars(select(ApiKey).order_by(ApiKey.id.desc()))]


@router.post("", status_code=201, dependencies=[Depends(builder)])
def add_key(body: KeyCreate, session: SessionDep) -> KeyCreated:
    models, model_ids = resolve(session, body.models)
    taken = name_clash(session, body.name, models, model_ids)
    if taken is not None:
        raise ConflictError(f"A key called {body.name} already calls {taken}.")
    key, secret = create_key(session, body.name, models, model_ids)
    key.created_by = current_actor()
    audit(session, "key.create", key)
    session.commit()
    return KeyCreated(secret=secret, **key_info(session, key).model_dump())


@router.put("/{key_id}/models", dependencies=[Depends(builder)])
def update_models(key_id: int, body: KeyScopeUpdate, session: SessionDep) -> KeyInfo:
    key = get_key(session, key_id)
    models, model_ids = resolve(session, body.models)
    set_scopes(session, key, models, model_ids)
    audit(session, "key.update", key)
    session.commit()
    return key_info(session, key)


@router.delete("/{key_id}", status_code=204, dependencies=[Depends(builder)])
def revoke(key_id: int, session: SessionDep) -> None:
    key = get_key(session, key_id)
    audit(session, "key.revoke", key)
    session.delete(key)
    session.commit()
