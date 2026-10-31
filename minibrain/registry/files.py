from enum import StrEnum
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.artifacts import ArtifactStore, Packing
from minibrain.registry.models import Artifact, Minibrain, Snapshot, Version
from minibrain.settings import Settings


class MissingArtifactError(Exception):
    pass


class ArtifactKind(StrEnum):
    SOURCE = "source"
    SNAPSHOT = "snapshot"
    ADAPTER = "adapter"
    LOG = "log"


def store_for(settings: Settings) -> ArtifactStore:
    return ArtifactStore(settings.artifacts_dir(), settings.cache_dir())


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


def store_dir(session: Session, store: ArtifactStore, path: Path, kind: str, name: str) -> Artifact:
    stored = store.put_dir(path)
    return register(session, stored.id, kind, Packing.TAR, name, stored.size)


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


def snapshot_dir(session: Session, store: ArtifactStore, snapshot: Snapshot) -> Path:
    if snapshot.artifact_id is not None:
        return materialize(session, store, snapshot.artifact_id)
    if snapshot.directory is None:
        raise MissingArtifactError(f"snapshot {snapshot.hash[:12]} has no files")
    return Path(snapshot.directory)


def adapter_dir(session: Session, store: ArtifactStore, version: Version) -> Path | None:
    if version.adapter_artifact_id is not None:
        return materialize(session, store, version.adapter_artifact_id)
    return Path(version.adapter_dir) if version.adapter_dir else None


def source_path(session: Session, store: ArtifactStore, minibrain: Minibrain) -> Path | None:
    if minibrain.source_artifact_id is None:
        return None
    return materialize(session, store, minibrain.source_artifact_id)


def backfill(session: Session, settings: Settings) -> int:
    store = store_for(settings)
    moved = 0
    for snapshot in session.scalars(select(Snapshot).where(Snapshot.artifact_id.is_(None))):
        if snapshot.directory and Path(snapshot.directory).is_dir():
            artifact = store_dir(session, store, Path(snapshot.directory), ArtifactKind.SNAPSHOT, "snapshot")
            snapshot.artifact_id = artifact.id
            moved += 1
    for version in session.scalars(select(Version).where(Version.adapter_artifact_id.is_(None))):
        if version.adapter_dir and Path(version.adapter_dir).is_dir():
            artifact = store_dir(session, store, Path(version.adapter_dir), ArtifactKind.ADAPTER, "adapter")
            version.adapter_artifact_id = artifact.id
            moved += 1
    for minibrain in session.scalars(select(Minibrain).where(Minibrain.source_artifact_id.is_(None))):
        legacy = settings.minibrain_dir(minibrain.slug) / "source" / (minibrain.source_file or "")
        if minibrain.source_file and legacy.is_file():
            minibrain.source_artifact_id = store_file(session, store, legacy, ArtifactKind.SOURCE).id
            moved += 1
    session.commit()
    return moved
