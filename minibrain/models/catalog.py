import json
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.registry.models import CatalogModel, CatalogVariant, Model, now
from minibrain.registry.settings_store import read, write

BUNDLED = Path(__file__).resolve().parent.parent / "catalog" / "catalog.json"
ENTRY_FIELDS = (
    "name",
    "description",
    "provider",
    "repo",
    "capabilities",
    "license",
    "license_name",
    "license_summary",
    "license_url",
    "gated",
    "recommended",
    "recommendation",
    "trainable",
    "template_kwargs",
    "stop_tokens",
    "popularity",
    "position",
)
VARIANT_FIELDS = (
    "label",
    "format",
    "precision",
    "repo",
    "revision",
    "files",
    "size_bytes",
    "weights_bytes",
    "runtimes",
    "requires",
)


SNAPSHOT_KEY = "catalog_snapshot"
DAILY_SYNC_KEY = "catalog_daily_sync"


def bundled() -> dict[str, Any]:
    return json.loads(BUNDLED.read_text())


def variant_in_use(session: Session, variant_id: str) -> bool:
    return session.scalar(select(Model.id).where(Model.variant_id == variant_id).limit(1)) is not None


def refresh_variant(session: Session, variant: CatalogVariant, data: dict[str, Any]) -> None:
    variant.latest_revision = data["revision"]
    if data["revision"] != variant.revision and not variant_in_use(session, variant.id):
        variant.revision = data["revision"]
        variant.files = data["files"]
        variant.size_bytes = data["size_bytes"]
        variant.weights_bytes = data["weights_bytes"]


def upsert(session: Session, entry: dict[str, Any]) -> None:
    model = session.get(CatalogModel, entry["id"])
    if model is None:
        model = CatalogModel(id=entry["id"])
        session.add(model)
    for key in ENTRY_FIELDS:
        setattr(model, key, entry[key])
    known = {variant.id: variant for variant in model.variants}
    for position, data in enumerate(entry["variants"]):
        variant = known.get(data["id"])
        if variant is None:
            fields = {key: data[key] for key in VARIANT_FIELDS}
            model.variants.append(CatalogVariant(id=data["id"], position=position, **fields))
            continue
        for key in ("label", "format", "precision", "repo", "runtimes", "requires"):
            setattr(variant, key, data[key])
        variant.position = position
        refresh_variant(session, variant, data)


def seed(session: Session) -> bool:
    snapshot = bundled()
    stored = read(session, SNAPSHOT_KEY)
    empty = session.scalar(select(CatalogModel.id).limit(1)) is None
    if not empty and stored is not None and stored >= snapshot["snapshot"]:
        return False
    for entry in snapshot["entries"]:
        upsert(session, entry)
    write(session, SNAPSHOT_KEY, snapshot["snapshot"])
    session.commit()
    return True


def apply_sync(session: Session, result: dict[str, Any]) -> None:
    moment = now()
    for variant_id, latest in result.get("variants", {}).items():
        variant = session.get(CatalogVariant, variant_id)
        if variant is not None:
            refresh_variant(session, variant, latest)
    for catalog_id, popularity in result.get("popularity", {}).items():
        entry = session.get(CatalogModel, catalog_id)
        if entry is not None:
            entry.popularity = int(popularity)
            entry.synced_at = moment


def sync_params(session: Session) -> dict[str, Any]:
    variants = session.scalars(select(CatalogVariant).order_by(CatalogVariant.catalog_id, CatalogVariant.position))
    return {"variants": [{"id": v.id, "catalog_id": v.catalog_id, "repo": v.repo} for v in variants]}


def daily_sync(session: Session) -> bool:
    return bool(read(session, DAILY_SYNC_KEY, False))
