import json
import re
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
from minibrain.models.rules import config_quantization
from minibrain.models.sources import (
    FOLDER,
    S3,
    SourceDeniedError,
    SourceMissingError,
    StorageSource,
    location_url,
    s3_base,
    s3_endpoint,
)
from minibrain.policy import PolicyError
from minibrain.policy import load as load_policy
from minibrain.registry.models import CatalogModel, CatalogVariant
from minibrain.settings import Settings

FRONT_MATTER = re.compile(r"\A---\s*\n(.*?)\n---", re.DOTALL)
LICENSE_LINE = re.compile(r"^license:\s*['\"]?([\w.+-]+)", re.MULTILINE)


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


def readme_license(source: StorageSource) -> str | None:
    try:
        text = source.read_text("README.md")
    except Exception:
        return None
    header = FRONT_MATTER.match(text)
    found = LICENSE_LINE.search(header.group(1)) if header else None
    return found.group(1) if found else None


def catalogue_match(session: Session, revision: str | None) -> tuple[CatalogVariant, CatalogModel] | None:
    if revision is None:
        return None
    variant = session.scalar(select(CatalogVariant).where(CatalogVariant.revision == revision).limit(1))
    if variant is None:
        return None
    entry = session.get(CatalogModel, variant.catalog_id)
    return (variant, entry) if entry is not None else None


def opened_source(
    session: Session, settings: Settings, location: str, connection_id: int | None, found: dict[str, Any]
) -> StorageSource:
    kind = source_type_of(location)
    found["source_type"] = kind
    url = location_url(kind, location)
    found["resolved"] = url
    connection = pick_connection(session, url, connection_id) if kind == S3 else None
    if connection is not None:
        found |= {"connection_id": connection.id, "connection": connection.name}
        return StorageSource(url, filesystem(resolve(session, settings, connection)))
    if kind == S3:
        load_policy(session).outbound(s3_endpoint())
    return StorageSource(url)


def inspect_location(
    session: Session, settings: Settings, location: str, connection_id: int | None = None
) -> dict[str, Any]:
    found: dict[str, Any] = {"ok": False, "problem": None, "source_type": None, "resolved": None}
    try:
        source = opened_source(session, settings, location, connection_id, found)
        files = source.files()
        checks = checklist(source, files)
    except SourceMissingError as error:
        return found | {"problem": str(error), "problem_kind": "not_found"}
    except (SourceDeniedError, ConnectionProblem, PermissionError) as error:
        return found | {"problem": str(error), "problem_kind": "no_access"}
    except PolicyError as error:
        return found | {"problem": str(error), "problem_kind": "policy"}
    except FinalError as error:
        return found | {"problem": str(error), "problem_kind": "invalid"}
    except Exception as error:
        problem = f"Cannot read {found['resolved'] or location}: {error}"
        return found | {"problem": problem, "problem_kind": "unreadable"}
    failed = [check for check in checks if not check["ok"]]
    weights = sum(item["size"] for item in files if item["path"].endswith(".safetensors"))
    found |= {
        "checks": checks,
        "files": len(files),
        "size_bytes": sum(item["size"] for item in files),
        "weights_bytes": weights,
    }
    if failed:
        return found | {"problem": f"{failed[0]['label']}: {failed[0]['detail']}", "problem_kind": "invalid"}
    config = json.loads(source.read_text("config.json"))
    matched = catalogue_match(session, detected_revision(source))
    variant, entry = matched if matched else (None, None)
    name = entry.name if entry else suggested_name(Path(location).name or location)
    return found | {
        "ok": True,
        "architecture": str(config.get("model_type") or ""),
        "name": name,
        "variant_id": variant.id if variant else None,
        "match": f"{entry.name} · {variant.label}" if entry and variant else None,
        "quantized": config_quantization(config),
        "license": readme_license(source),
        "config": config,
    }
