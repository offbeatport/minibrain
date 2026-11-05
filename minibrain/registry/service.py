import hashlib
import re
import secrets
from collections.abc import Sequence
from datetime import timedelta

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from minibrain.registry.models import (
    ApiKey,
    Dataset,
    KeyScope,
    Minibrain,
    Model,
    Snapshot,
    Version,
    now,
)

KEY_PREFIX = "mb_"


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
    return slug[:48].strip("-") or "minibrain"


def list_minibrains(session: Session) -> list[Minibrain]:
    return list(session.scalars(select(Minibrain).order_by(Minibrain.created_at)))


def get_minibrain(session: Session, slug: str) -> Minibrain:
    minibrain = session.scalar(select(Minibrain).where(Minibrain.slug == slug))
    if minibrain is None:
        raise NotFoundError(f"no model called {slug}")
    return minibrain


def taken_names(session: Session) -> tuple[set[str], set[str]]:
    custom = session.execute(select(Minibrain.name, Minibrain.slug)).all()
    bases = session.execute(select(Model.name, Model.id)).all()
    names = {name.strip().lower() for name, _ in [*custom, *bases]}
    slugs = {slug for _, slug in custom} | {slugify(key) for _, key in bases} | {key for _, key in bases}
    return names, slugs


def name_taken(session: Session, name: str) -> bool:
    names, slugs = taken_names(session)
    return name.strip().lower() in names or slugify(name) in slugs


def free_model_name(session: Session, noun: str, numbered: bool = True) -> str:
    names, slugs = taken_names(session)
    candidates = (noun if number == 1 and not numbered else f"{noun} {number}" for number in range(1, 10_000))
    return next(item for item in candidates if item.lower() not in names and slugify(item) not in slugs)


def create_minibrain(session: Session, name: str, preset: str, base_model: str) -> Minibrain:
    from minibrain.policy import load

    if not re.search(r"[A-Za-z0-9]", name):
        raise ModelNameError("a model name needs at least one letter or number")
    slug = slugify(name)
    if name_taken(session, name):
        raise ConflictError(f"a model called {name.strip()} already exists, or one with the same address ({slug})")
    bodies = bool(load(session)["request_bodies"])
    minibrain = Minibrain(slug=slug, name=name.strip(), preset=preset, base_model=base_model, request_bodies=bodies)
    session.add(minibrain)
    session.flush()
    return minibrain


def latest_version(dataset: Dataset) -> Snapshot | None:
    numbered = [snapshot for snapshot in dataset.snapshots if snapshot.number is not None]
    return max(numbered, key=lambda snapshot: snapshot.number or 0, default=None)


def latest_snapshot(minibrain: Minibrain) -> Snapshot | None:
    return latest_version(minibrain.dataset) if minibrain.dataset is not None else None


def find_version(minibrain: Minibrain, number: int) -> Version | None:
    return next((version for version in minibrain.versions if version.number == number), None)


def get_version(minibrain: Minibrain, number: int) -> Version:
    version = find_version(minibrain, number)
    if version is None:
        raise NotFoundError(f"{minibrain.slug}@{number} not found")
    return version


def adapter_name(slug: str, number: int) -> str:
    return f"{slug}-v{number}"


def key_digest(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def scopes_of(minibrains: Sequence[Minibrain] = (), model_ids: Sequence[str] = ()) -> list[KeyScope]:
    return [KeyScope(minibrain=minibrain) for minibrain in minibrains] + [
        KeyScope(model_id=model_id) for model_id in dict.fromkeys(model_ids)
    ]


def create_key(
    session: Session, name: str, minibrains: Sequence[Minibrain] = (), model_ids: Sequence[str] = ()
) -> tuple[ApiKey, str]:
    from minibrain.policy import load

    raw = KEY_PREFIX + secrets.token_urlsafe(32)
    days = int(load(session)["key_expiry_days"])
    key = ApiKey(
        name=name.strip() or "default",
        prefix=raw[:10],
        digest=key_digest(raw),
        expires_at=now() + timedelta(days=days) if days else None,
        scopes=scopes_of(minibrains, model_ids),
    )
    session.add(key)
    session.commit()
    return key, raw


def set_scopes(
    session: Session, key: ApiKey, minibrains: Sequence[Minibrain] = (), model_ids: Sequence[str] = ()
) -> None:
    key.scopes.clear()
    session.flush()
    key.scopes.extend(scopes_of(minibrains, model_ids))
    session.commit()


def covers(key: ApiKey, minibrain: Minibrain | None = None, model_id: str | None = None) -> bool:
    if minibrain is not None:
        return any(scope.minibrain_id == minibrain.id for scope in key.scopes)
    return any(scope.model_id == model_id for scope in key.scopes)


def drop_orphan_keys(session: Session) -> None:
    session.flush()
    session.execute(delete(ApiKey).where(~ApiKey.scopes.any()), execution_options={"synchronize_session": False})
    session.expire_all()
