import json
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.connections.imports import pick_connection
from minibrain.connections.s3 import filesystem
from minibrain.connections.spec import ConnectionProblem
from minibrain.connections.store import resolve
from minibrain.ml.context import FinalError
from minibrain.models.importer import checklist, detected_revision
from minibrain.models.sources import FOLDER, S3, StorageSource, location_url, s3_base, s3_endpoint
from minibrain.policy import PolicyError
from minibrain.policy import load as load_policy
from minibrain.registry.models import CatalogModel, CatalogVariant
from minibrain.settings import Settings


def source_type_of(location: str) -> str:
    location = location.strip()
    if location.startswith("s3://"):
        return S3
    if location.startswith(("/", "~")):
        return FOLDER
    if s3_base() is not None:
        return S3
    raise FinalError("Give an absolute folder path on the server or an s3:// URL")


def suggested_name(location: str) -> str:
    leaf = location.strip().rstrip("/").rsplit("/", 1)[-1]
    return leaf.replace("_", " ").replace("-", " ").strip() or "Imported model"


def catalogue_match(session: Session, revision: str | None) -> tuple[CatalogVariant, CatalogModel] | None:
    if revision is None:
        return None
    variant = session.scalar(select(CatalogVariant).where(CatalogVariant.revision == revision).limit(1))
    if variant is None:
        return None
    entry = session.get(CatalogModel, variant.catalog_id)
    return (variant, entry) if entry is not None else None


def inspect_location(
    session: Session, settings: Settings, location: str, connection_id: int | None = None
) -> dict[str, Any]:
    found: dict[str, Any] = {"ok": False, "problem": None, "source_type": None, "resolved": None}
    try:
        kind = source_type_of(location)
        found["source_type"] = kind
        url = location_url(kind, location)
        found["resolved"] = url
        connection = pick_connection(session, url, connection_id) if kind == S3 else None
        if connection is not None:
            found |= {"connection_id": connection.id, "connection": connection.name}
            source = StorageSource(url, filesystem(resolve(session, settings, connection)))
        else:
            if kind == S3:
                load_policy(session).outbound(s3_endpoint())
            source = StorageSource(url)
        files = source.files()
        checks = checklist(source, files)
    except (FinalError, PolicyError, ConnectionProblem) as error:
        return found | {"problem": str(error)}
    except Exception as error:
        return found | {"problem": f"Cannot read {found['resolved'] or location}: {error}"}
    failed = [check for check in checks if not check["ok"]]
    found |= {"checks": checks, "files": len(files), "size_bytes": sum(item["size"] for item in files)}
    if failed:
        return found | {"problem": f"{failed[0]['label']}: {failed[0]['detail']}"}
    config = json.loads(source.read_text("config.json"))
    architecture = str(config.get("model_type") or "")
    matched = catalogue_match(session, detected_revision(source))
    variant, entry = matched if matched else (None, None)
    return found | {
        "ok": True,
        "architecture": architecture,
        "name": entry.name if entry else suggested_name(Path(location).name or location),
        "variant_id": variant.id if variant else None,
        "match": f"{entry.name} · {variant.label}" if entry and variant else None,
    }
