from typing import Any

from sqlalchemy.orm import Session

from minibrain.models.registry import resolve_spec
from minibrain.recipes import DEFAULT_RECIPE
from minibrain.registry.files import MissingArtifactError, ref
from minibrain.registry.models import Minibrain, Version
from minibrain.settings import Settings


def prepare_params(session: Session, minibrain: Minibrain, sql: str) -> dict[str, Any]:
    source = ref(session, minibrain.source_artifact_id)
    if source is None:
        raise MissingArtifactError("upload a data file first")
    return {"source": source, "sql": sql}


def snapshot_ref(session: Session, version: Version) -> dict[str, Any]:
    snapshot = ref(session, version.snapshot.artifact_id)
    if snapshot is None:
        raise MissingArtifactError(f"snapshot {version.snapshot.hash[:12]} has no artifact")
    return snapshot


def base_spec(session: Session, settings: Settings, version: Version) -> dict[str, Any]:
    return resolve_spec(session, settings, version.minibrain.base_model).as_dict()


def train_params(session: Session, settings: Settings, version: Version) -> dict[str, Any]:
    return {
        "slug": version.minibrain.slug,
        "number": version.number,
        "base_model": version.minibrain.base_model,
        "base_spec": base_spec(session, settings, version),
        "snapshot": snapshot_ref(session, version),
        "recipe": DEFAULT_RECIPE | dict(version.recipe),
    }


def eval_params(session: Session, settings: Settings, version: Version) -> dict[str, Any]:
    return {
        "slug": version.minibrain.slug,
        "number": version.number,
        "base_model": version.minibrain.base_model,
        "base_spec": base_spec(session, settings, version),
        "version_kind": version.kind,
        "snapshot": snapshot_ref(session, version),
        "adapter": ref(session, version.adapter_artifact_id),
    }
