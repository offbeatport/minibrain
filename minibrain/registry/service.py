import hashlib
import re
import secrets
from collections.abc import Sequence
from datetime import timedelta

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from minibrain.registry.models import (
    ApiKey,
    BaseModel,
    Dataset,
    DatasetVersion,
    KeyScope,
    Model,
    Version,
    now,
)

KEY_PREFIX = "mb_"
RESERVED_ADDRESSES = frozenset({"new", "base", "custom"})


class NotFoundError(Exception):
    pass


class ConflictError(Exception):
    pass


class NameTakenError(ConflictError):
    def __init__(self, message: str, name: str, suggestion: str, taken: int | str) -> None:
        super().__init__(message)
        self.name = name
        self.suggestion = suggestion
        self.taken = taken


class ModelNameError(ValueError):
    pass


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug[:48].strip("-") or "model"


def list_models(session: Session) -> list[Model]:
    return list(session.scalars(select(Model).order_by(Model.created_at)))


def get_model(session: Session, slug: str) -> Model:
    model = session.scalar(select(Model).where(Model.slug == slug))
    if model is None:
        raise NotFoundError(f"no model called {slug}")
    return model


def taken_names(session: Session) -> tuple[set[str], set[str]]:
    custom = session.execute(select(Model.name, Model.slug)).all()
    bases = session.execute(select(BaseModel.name, BaseModel.id)).all()
    names = {name.strip().lower() for name, _ in [*custom, *bases]}
    slugs = {slug for _, slug in custom} | {slugify(key) for _, key in bases} | {key for _, key in bases}
    return names, slugs | RESERVED_ADDRESSES


def address_taken(session: Session, address: str) -> bool:
    custom = session.scalar(select(Model.id).where(Model.slug == address))
    return address in RESERVED_ADDRESSES or custom is not None or session.get(BaseModel, address) is not None


def check_rename(session: Session, current: str, name: str) -> None:
    wanted = name.strip().lower()
    if wanted == current.strip().lower():
        return
    names, _ = taken_names(session)
    if wanted in names:
        raise ConflictError(f"a model called {name.strip()} already exists; base and custom models share names")


def name_taken(session: Session, name: str) -> bool:
    names, slugs = taken_names(session)
    return name.strip().lower() in names or slugify(name) in slugs


def free_model_name(session: Session, noun: str, numbered: bool = True) -> str:
    names, slugs = taken_names(session)
    candidates = (noun if number == 1 and not numbered else f"{noun} {number}" for number in range(1, 10_000))
    return next(item for item in candidates if item.lower() not in names and slugify(item) not in slugs)


def create_model(session: Session, name: str, preset: str, base_model: str) -> Model:
    from minibrain.policy import load

    if not re.search(r"[A-Za-z0-9]", name):
        raise ModelNameError("a model name needs at least one letter or number")
    slug = slugify(name)
    if name_taken(session, name):
        raise ConflictError(f"a model called {name.strip()} already exists, or one with the same address ({slug})")
    bodies = bool(load(session)["request_bodies"])
    model = Model(slug=slug, name=name.strip(), preset=preset, base_model=base_model, request_bodies=bodies)
    session.add(model)
    session.flush()
    return model


def latest_version(dataset: Dataset) -> DatasetVersion | None:
    numbered = [dataset_version for dataset_version in dataset.versions if dataset_version.number is not None]
    return max(numbered, key=lambda dataset_version: dataset_version.number or 0, default=None)


def latest_dataset_version(model: Model) -> DatasetVersion | None:
    return latest_version(model.dataset) if model.dataset is not None else None


def find_version(model: Model, number: int) -> Version | None:
    return next((version for version in model.versions if version.number == number), None)


def get_version(model: Model, number: int) -> Version:
    version = find_version(model, number)
    if version is None:
        raise NotFoundError(f"{model.slug}@{number} not found")
    return version


def adapter_name(slug: str, number: int) -> str:
    return f"{slug}-v{number}"


def key_digest(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def scopes_of(models: Sequence[Model] = (), model_ids: Sequence[str] = ()) -> list[KeyScope]:
    return [KeyScope(model=model) for model in models] + [
        KeyScope(base_model_id=base_model_id) for base_model_id in dict.fromkeys(model_ids)
    ]


def create_key(
    session: Session, name: str, models: Sequence[Model] = (), model_ids: Sequence[str] = ()
) -> tuple[ApiKey, str]:
    from minibrain.policy import load

    raw = KEY_PREFIX + secrets.token_urlsafe(32)
    days = int(load(session)["key_expiry_days"])
    key = ApiKey(
        name=name.strip() or "default",
        prefix=raw[:10],
        digest=key_digest(raw),
        expires_at=now() + timedelta(days=days) if days else None,
        scopes=scopes_of(models, model_ids),
    )
    session.add(key)
    session.commit()
    return key, raw


def set_scopes(session: Session, key: ApiKey, models: Sequence[Model] = (), model_ids: Sequence[str] = ()) -> None:
    key.scopes.clear()
    session.flush()
    key.scopes.extend(scopes_of(models, model_ids))
    session.commit()


def covers(key: ApiKey, model: Model | None = None, base_model_id: str | None = None) -> bool:
    if model is not None:
        return any(scope.model_id == model.id for scope in key.scopes)
    return any(scope.base_model_id == base_model_id for scope in key.scopes)


def drop_orphan_keys(session: Session) -> None:
    session.flush()
    session.execute(delete(ApiKey).where(~ApiKey.scopes.any()), execution_options={"synchronize_session": False})
    session.expire_all()
