from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.base_models import BASE_MODELS, BaseModelSpec
from minibrain.models.registry import base_config, base_readiness, gguf_file, model_id_for, resolve_spec
from minibrain.models.train_facts import variant_quantization
from minibrain.registry.models import (
    BaseModel,
    CatalogModel,
    CatalogVariant,
    Model,
    TeardownKind,
    Version,
    VersionStatus,
)
from minibrain.registry.service import ConflictError, NotFoundError
from minibrain.settings import Settings


@dataclass(frozen=True)
class Target:
    key: str
    name: str
    catalog_id: str
    variant_id: str
    size_bytes: int
    installed: bool


@dataclass(frozen=True)
class ServeOnly:
    format: str
    reason: str
    target: Target | None


def base_name(session: Session, key: str) -> str:
    found = session.get(BaseModel, key)
    if found is not None:
        return found.name
    entry = session.get(CatalogModel, key) if key in BASE_MODELS else None
    return entry.name if entry is not None else key


def imported_quantization(settings: Settings, base: BaseModel) -> str | None:
    if gguf_file(base):
        return "gguf"
    config = base_config(settings, base) or {}
    found = config.get("quantization_config")
    method = found.get("quant_method") if isinstance(found, dict) else None
    return str(method) if method else None


def quantized_format(session: Session, settings: Settings, key: str) -> str | None:
    base = session.get(BaseModel, key)
    if base is None:
        return None
    if base.variant is not None:
        return variant_quantization(base.variant)
    return imported_quantization(settings, base)


def catalogue_entry(session: Session, key: str) -> CatalogModel | None:
    base = session.get(BaseModel, key)
    return session.get(CatalogModel, base.catalog_id if base is not None and base.catalog_id else key)


def installed_variant(session: Session, variant: CatalogVariant) -> BaseModel | None:
    found = session.get(BaseModel, model_id_for(variant))
    if found is not None:
        return found
    return session.scalar(select(BaseModel).where(BaseModel.variant_id == variant.id).limit(1))


def trainable_target(session: Session, key: str) -> Target | None:
    entry = catalogue_entry(session, key)
    if entry is None:
        return None
    variant = next((item for item in entry.variants if variant_quantization(item) is None), None)
    if variant is None:
        return None
    base = installed_variant(session, variant)
    key = base.id if base is not None else model_id_for(variant)
    return Target(
        key=key,
        name=base.name if base is not None else f"{entry.name} {variant.precision.upper()}",
        catalog_id=entry.id,
        variant_id=variant.id,
        size_bytes=variant.size_bytes,
        installed=base_readiness(session, key) != "missing",
    )


def serve_only(session: Session, settings: Settings, key: str) -> ServeOnly | None:
    found = quantized_format(session, settings, key)
    if found is None:
        return None
    shown = found.upper()
    target = trainable_target(session, key)
    advice = f"Switch to {target.name} to train." if target else "Switch to a full-precision base to train."
    return ServeOnly(
        format=shown, reason=f"{base_name(session, key)} is {shown}, which serves only. {advice}", target=target
    )


def other_base(session: Session, model: Model, version: Version) -> str | None:
    if version.base_model == model.base_model:
        return None
    made_on = base_name(session, version.base_model)
    now_on = base_name(session, model.base_model)
    return (
        f"v{version.number} was made on {made_on}, and {model.name} is on {now_on} now. "
        f"Only versions made on {now_on} can be deployed; score or train one there."
    )


def spec_of(session: Session, settings: Settings, key: str) -> BaseModelSpec | None:
    try:
        return resolve_spec(session, settings, key)
    except NotFoundError:
        return None


def lost_features(session: Session, settings: Settings, model: Model, key: str) -> list[str]:
    source = spec_of(session, settings, model.base_model)
    target = spec_of(session, settings, key)
    if source is None or target is None:
        return []
    name = base_name(session, key)
    found: list[str] = []
    if source.tools and not target.tools:
        found.append(f"{name} can't call tools: requests to {model.slug} that send tools will be refused.")
    if source.reasoning and not target.reasoning:
        found.append(f"{name} doesn't reason: answers come without reasoning.")
    return found


def require_switchable(session: Session, model: Model, key: str) -> None:
    if key == model.base_model:
        raise ConflictError(f"{model.name} is already on {base_name(session, key)}")
    readiness = base_readiness(session, key)
    if readiness == "missing":
        raise ConflictError(f"{key} is not a base model on this install; download or import it first")
    base = session.get(BaseModel, key)
    teardown = base.teardown if base is not None else None
    if base is not None and teardown is not None and teardown.kind == TeardownKind.DELETE:
        raise ConflictError(f"{base.name} is being deleted; pick another base")
    training = [version.number for version in model.versions if version.status == VersionStatus.TRAINING]
    if training:
        raise ConflictError(f"v{training[0]} is still training on the current base; wait for it or cancel it first")


def installed_keys(session: Session) -> list[str]:
    keys = [base.id for base in session.scalars(select(BaseModel).order_by(BaseModel.name))]
    return [*keys, *(key for key in BASE_MODELS if key not in keys)]
