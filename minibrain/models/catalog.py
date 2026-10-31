import json
import os
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
    "family",
    "generation",
    "architecture",
    "tier",
    "params_b",
    "moe",
    "support",
    "superseded_by",
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
        if key in entry:
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


def catalog_url() -> str | None:
    found = os.environ.get("MINIBRAIN_CATALOG_URL", "").strip()
    return found or None


def apply_sync(session: Session, result: dict[str, Any]) -> None:
    moment = now()
    for entry in result.get("entries", []):
        upsert(session, entry)
        found = session.get(CatalogModel, entry["id"])
        if found is not None:
            found.synced_at = moment
    if result.get("snapshot"):
        write(session, SNAPSHOT_KEY, result["snapshot"])


def sync_params(_session: Session) -> dict[str, Any]:
    return {"url": catalog_url()}


def daily_sync(session: Session) -> bool:
    return bool(read(session, DAILY_SYNC_KEY, False))
