import hashlib
import re
import secrets
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.registry.models import (
    ApiKey,
    BaseModel,
    Dataset,
    DatasetVersion,
    KeyScope,
    Model,
    ReservedName,
    Version,
    now,
)

KEY_PREFIX = "mb_"
RESERVED_ADDRESSES = frozenset({"new", "base", "custom", "name"})
ADDRESS_LENGTH = 48
ADDRESS = re.compile(r"[a-z0-9](?:[a-z0-9.-]{0,46}[a-z0-9])?")


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


def reserved_name(session: Session, name: str) -> ReservedName | None:
    return session.get(ReservedName, name.partition("@")[0])


def deleted_on(reserved: ReservedName) -> str:
    return f"{reserved.name} was deleted on {reserved.deleted_at:%Y-%m-%d}"


def no_model(session: Session, name: str) -> NotFoundError:
    reserved = reserved_name(session, name)
    return NotFoundError(deleted_on(reserved) if reserved is not None else f"no model called {name}")


def reserve_name(session: Session, name: str, kind: str, model_name: str, actor: str) -> None:
    if session.get(ReservedName, name) is None:
        session.add(ReservedName(name=name, kind=kind, model_name=model_name, deleted_by=actor))


def get_model(session: Session, slug: str) -> Model:
    model = session.scalar(select(Model).where(Model.slug == slug))
    if model is None:
        raise no_model(session, slug)
    return model


def taken_names(session: Session) -> tuple[set[str], set[str]]:
    custom = session.execute(select(Model.name, Model.slug)).all()
    bases = session.execute(select(BaseModel.name, BaseModel.id)).all()
    names = {name.strip().lower() for name, _ in [*custom, *bases]}
    slugs = {slug for _, slug in custom} | {slugify(key) for _, key in bases} | {key for _, key in bases}
    return names, slugs | RESERVED_ADDRESSES | set(session.scalars(select(ReservedName.name)))


def address_taken(session: Session, address: str) -> bool:
    return address in taken_names(session)[1]


def check_rename(session: Session, current: str, name: str) -> None:
    wanted = name.strip().lower()
    if wanted == current.strip().lower():
        return
    names, _ = taken_names(session)
    if wanted in names:
        raise ConflictError(f"a model called {name.strip()} already exists; base and custom models share names")


def name_taken(session: Session, name: str) -> bool:
    return name.strip().lower() in taken_names(session)[0]


def require_free_name(session: Session, name: str) -> None:
    if name_taken(session, name):
        raise ConflictError(f"a model called {name.strip()} already exists; base and custom models share names")


def suffixed(stem: str, number: int) -> str:
    if number == 1:
        return stem
    tail = f"-{number}"
    return f"{stem[: ADDRESS_LENGTH - len(tail)].rstrip('-.')}{tail}"


def free_address(session: Session, stem: str) -> str:
    _, held = taken_names(session)
    return next(suffixed(stem, number) for number in range(1, 10_000) if suffixed(stem, number) not in held)


def blocked_address(session: Session, address: str) -> ReservedName | None:
    return session.get(ReservedName, address)


def reserved_refusal(reserved: ReservedName) -> str:
    day = f"{reserved.deleted_at:%b} {reserved.deleted_at.day}"
    return f"{reserved.name} belonged to a deleted model (deleted {day}); pick another name"


def require_address(session: Session, address: str) -> str:
    if not ADDRESS.fullmatch(address):
        raise ModelNameError(
            f"{address} is not a valid API name: lowercase letters, numbers, dots and dashes, up to 48 characters"
        )
    reserved = blocked_address(session, address)
    if reserved is not None:
        raise ConflictError(reserved_refusal(reserved))
    if address_taken(session, address):
        raise ConflictError(f"another model already uses the API name {address}; pick another name")
    return address


def address_for(session: Session, stem: str, wanted: str | None = None) -> str:
    return require_address(session, wanted.strip()) if wanted else free_address(session, stem)


@dataclass(frozen=True)
class AddressPreview:
    address: str
    reserved: ReservedName | None


def preview_address(session: Session, stem: str) -> AddressPreview:
    return AddressPreview(free_address(session, stem), blocked_address(session, stem))


def free_model_name(session: Session, noun: str, numbered: bool = True) -> str:
    names, slugs = taken_names(session)
    candidates = (noun if number == 1 and not numbered else f"{noun} {number}" for number in range(1, 10_000))
    return next(item for item in candidates if item.lower() not in names and slugify(item) not in slugs)


def create_model(session: Session, name: str, preset: str, base_model: str, api_name: str | None = None) -> Model:
    from minibrain.policy import load

    if not re.search(r"[A-Za-z0-9]", name):
        raise ModelNameError("a model name needs at least one letter or number")
    require_free_name(session, name)
    slug = address_for(session, slugify(name), api_name)
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


def key_expiry_limit(session: Session) -> int:
    from minibrain.policy import load

    return int(load(session)["key_expiry_days"])


def create_key(
    session: Session,
    name: str,
    models: Sequence[Model] = (),
    model_ids: Sequence[str] = (),
    all_models: bool = False,
    days: int | None = None,
) -> tuple[ApiKey, str]:
    raw = KEY_PREFIX + secrets.token_urlsafe(32)
    lasts = days or key_expiry_limit(session)
    key = ApiKey(
        name=name.strip(),
        prefix=raw[:10],
        digest=key_digest(raw),
        expires_at=now() + timedelta(days=lasts) if lasts else None,
        all_models=all_models,
        scopes=[] if all_models else scopes_of(models, model_ids),
    )
    session.add(key)
    session.commit()
    return key, raw


def set_scopes(
    session: Session,
    key: ApiKey,
    models: Sequence[Model] = (),
    model_ids: Sequence[str] = (),
    all_models: bool = False,
) -> None:
    key.scopes.clear()
    session.flush()
    key.all_models = all_models
    key.scopes.extend([] if all_models else scopes_of(models, model_ids))
    session.commit()


def covers(key: ApiKey, model: Model | None = None, base_model_id: str | None = None) -> bool:
    if key.all_models:
        return True
    if model is not None:
        return any(scope.model_id == model.id for scope in key.scopes)
    return any(scope.base_model_id == base_model_id for scope in key.scopes)
