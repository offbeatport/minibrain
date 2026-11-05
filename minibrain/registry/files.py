from enum import StrEnum
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from minibrain.artifacts import ArtifactStore, Packing
from minibrain.encryption.keys import keys_for
from minibrain.registry.models import Artifact, Snapshot
from minibrain.settings import Settings


class MissingArtifactError(Exception):
    pass


class ArtifactKind(StrEnum):
    SOURCE = "source"
    SNAPSHOT = "snapshot"
    ADAPTER = "adapter"
    LOG = "log"


STORES: dict[Path, ArtifactStore] = {}


def store_for(settings: Settings) -> ArtifactStore:
    root = settings.artifacts_dir()
    if root not in STORES:
        STORES[root] = ArtifactStore(root, settings.cache_dir(), keys_for(settings), settings.home / "staging")
    return STORES[root]


def register(session: Session, artifact_id: str, kind: str, packing: str, name: str, size: int) -> Artifact:
    artifact = session.get(Artifact, artifact_id)
    if artifact is None:
        artifact = Artifact(id=artifact_id, kind=kind, packing=packing, name=name, size=size)
        session.add(artifact)
        session.flush()
    return artifact


def store_file(session: Session, store: ArtifactStore, path: Path, kind: str) -> Artifact:
    stored = store.put_file(path)
    return register(session, stored.id, kind, Packing.FILE, path.name, stored.size)


def ref(session: Session, artifact_id: str | None) -> dict[str, Any] | None:
    if artifact_id is None:
        return None
    artifact = session.get(Artifact, artifact_id)
    if artifact is None:
        raise MissingArtifactError(f"artifact {artifact_id} is not registered")
    return {"id": artifact.id, "packing": artifact.packing, "name": artifact.name}


def materialize(session: Session, store: ArtifactStore, artifact_id: str) -> Path:
    found = ref(session, artifact_id)
    if found is None:
        raise MissingArtifactError("no artifact")
    return store.materialize(found["id"], found["packing"], found["name"])


def snapshot_location(session: Session, store: ArtifactStore, snapshot: Snapshot) -> str:
    found = ref(session, snapshot.artifact_id)
    if found is None:
        raise MissingArtifactError(f"snapshot {snapshot.hash[:12]} has no files")
    return store.url(found["id"], found["name"])
