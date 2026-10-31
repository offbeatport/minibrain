import hashlib
import re
import secrets
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.registry.models import (
    ApiKey,
    Minibrain,
    Snapshot,
    Version,
    VersionKind,
    VersionStatus,
)

KEY_PREFIX = "mb_"


class NotFoundError(Exception):
    pass


class ConflictError(Exception):
    pass


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug[:48].strip("-") or "minibrain"


def list_minibrains(session: Session) -> list[Minibrain]:
    return list(session.scalars(select(Minibrain).order_by(Minibrain.created_at)))


def get_minibrain(session: Session, slug: str) -> Minibrain:
    minibrain = session.scalar(select(Minibrain).where(Minibrain.slug == slug))
    if minibrain is None:
        raise NotFoundError(f"minibrain {slug} not found")
    return minibrain


def create_minibrain(session: Session, name: str, task: str, base_model: str) -> Minibrain:
    slug = slugify(name)
    if session.scalar(select(Minibrain).where(Minibrain.slug == slug)) is not None:
        raise ConflictError(f"a minibrain called {slug} already exists")
    minibrain = Minibrain(slug=slug, name=name.strip(), task=task, base_model=base_model)
    session.add(minibrain)
    session.commit()
    return minibrain


def latest_snapshot(minibrain: Minibrain) -> Snapshot | None:
    return max(minibrain.snapshots, key=lambda snapshot: snapshot.id, default=None)


def find_version(minibrain: Minibrain, number: int) -> Version | None:
    return next((version for version in minibrain.versions if version.number == number), None)


def get_version(minibrain: Minibrain, number: int) -> Version:
    version = find_version(minibrain, number)
    if version is None:
        raise NotFoundError(f"{minibrain.slug}@{number} not found")
    return version


def next_version_number(minibrain: Minibrain) -> int:
    return max((version.number for version in minibrain.versions), default=-1) + 1


def create_version(session: Session, minibrain: Minibrain, kind: VersionKind, recipe: dict[str, Any]) -> Version:
    snapshot = latest_snapshot(minibrain)
    if snapshot is None:
        raise ConflictError("build the dataset before creating a version")
    version = Version(
        minibrain=minibrain,
        snapshot=snapshot,
        number=next_version_number(minibrain),
        kind=kind,
        status=VersionStatus.TRAINING if kind == VersionKind.LORA else VersionStatus.EVALUATING,
        recipe=recipe,
    )
    session.add(version)
    session.flush()
    return version


def adapter_name(slug: str, number: int) -> str:
    return f"{slug}-v{number}"


def held_out_accuracy(version: Version) -> float:
    return float((version.metrics or {}).get("eval", {}).get("accuracy", 0.0))


def promote(minibrain: Minibrain, version: Version, override: bool) -> None:
    if version.status != VersionStatus.READY:
        raise ConflictError(f"{minibrain.slug}@{version.number} is not ready")
    current = find_version(minibrain, minibrain.current_version) if minibrain.current_version is not None else None
    if current is not None and not override and held_out_accuracy(version) < held_out_accuracy(current):
        raise ConflictError(
            f"{minibrain.slug}@{version.number} scores below {minibrain.slug}@{current.number} on the held-out split"
        )
    minibrain.current_version = version.number


def key_digest(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def create_key(session: Session, minibrain: Minibrain, name: str) -> tuple[ApiKey, str]:
    raw = KEY_PREFIX + secrets.token_urlsafe(32)
    key = ApiKey(minibrain=minibrain, name=name.strip() or "default", prefix=raw[:10], digest=key_digest(raw))
    session.add(key)
    session.commit()
    return key, raw


def find_key(session: Session, raw: str) -> ApiKey | None:
    if not raw.startswith(KEY_PREFIX):
        return None
    return session.scalar(select(ApiKey).where(ApiKey.digest == key_digest(raw)))
