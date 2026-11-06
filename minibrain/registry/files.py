import hashlib
import tarfile
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import IO, Any

from sqlalchemy.orm import Session

from minibrain.artifacts import CHUNK, ArtifactStore, Packing
from minibrain.encryption.keys import keys_for
from minibrain.registry.models import Artifact, DatasetVersion
from minibrain.settings import Settings


class MissingArtifactError(Exception):
    pass


class ArtifactKind(StrEnum):
    SOURCE = "source"
    DATASET_VERSION = "dataset_version"
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


def dataset_version_location(session: Session, store: ArtifactStore, dataset_version: DatasetVersion) -> str:
    found = ref(session, dataset_version.artifact_id)
    if found is None:
        raise MissingArtifactError(f"dataset version {dataset_version.hash[:12]} has no files")
    return store.url(found["id"], found["name"])


@dataclass(frozen=True)
class PackedFile:
    path: str
    size: int
    sha256: str


PACKED: dict[str, list[PackedFile]] = {}


def digest(stream: IO[bytes]) -> tuple[int, str]:
    hasher = hashlib.sha256()
    size = 0
    while chunk := stream.read(CHUNK):
        hasher.update(chunk)
        size += len(chunk)
    return size, hasher.hexdigest()


def read_packed(store: ArtifactStore, artifact: Artifact) -> list[PackedFile]:
    with store.open(artifact.id) as stream:
        if artifact.packing == Packing.FILE:
            size, sha256 = digest(stream)
            return [PackedFile(path=artifact.name, size=size, sha256=sha256)]
        found: list[PackedFile] = []
        with tarfile.open(fileobj=stream, mode="r|") as archive:
            for member in archive:
                content = archive.extractfile(member) if member.isfile() else None
                if content is not None:
                    size, sha256 = digest(content)
                    found.append(PackedFile(path=member.name.removeprefix("./"), size=size, sha256=sha256))
        return sorted(found, key=lambda item: item.path)


def packed_files(store: ArtifactStore, artifact: Artifact) -> list[PackedFile]:
    if artifact.id not in PACKED:
        PACKED[artifact.id] = read_packed(store, artifact)
    return PACKED[artifact.id]
