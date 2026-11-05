import base64
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.artifacts import ArtifactStore
from minibrain.encryption.envelope import is_sealed, parse_header
from minibrain.encryption.sealed import artifact_context, unwrap_any
from minibrain.models.copies import file_entry
from minibrain.models.health import CORRUPT, MISSING, WRONG_SIZE, content_hash
from minibrain.registry.models import ACTIVE_JOB_STATUSES, Artifact, BaseModel, BaseModelStatus, Job, JobKind

WEIGHTS = "weights"
PRESIGN_SECONDS = 900
BAD_STATES = (CORRUPT, MISSING, WRONG_SIZE)


class BucketError(Exception):
    pass


def writes_bucket(store: ArtifactStore) -> bool:
    return store.writes_remote and store.remote is not None


def hashes_of(model: BaseModel) -> list[str]:
    return [str(entry["sha256"]) for entry in model.files if entry.get("sha256")]


def registered(session: Session, ids: list[str]) -> set[str]:
    if not ids:
        return set()
    return set(session.scalars(select(Artifact.id).where(Artifact.id.in_(ids))))


def missing_objects(session: Session, model: BaseModel) -> dict[str, str]:
    found = registered(session, hashes_of(model))
    return {
        str(entry["path"]): MISSING
        for entry in model.files
        if not entry.get("sha256") or str(entry["sha256"]) not in found
    }


def stored_files(session: Session, store: ArtifactStore, model: BaseModel) -> list[dict[str, Any]]:
    if not writes_bucket(store) or store.remote is None:
        return []
    states = dict((model.health_detail or {}).get("files") or {})
    found = registered(session, hashes_of(model))
    return [
        file_entry(entry)
        for entry in model.files
        if entry.get("sha256")
        and str(entry["sha256"]) in found
        and states.get(str(entry["path"])) not in BAD_STATES
        and store.remote.has(str(entry["sha256"]))
    ]


def data_key(store: ArtifactStore, artifact_id: str) -> str | None:
    if store.remote is None:
        raise BucketError("storage has no bucket")
    head = store.remote.head(artifact_id)
    if not is_sealed(head):
        return None
    if store.keys is None:
        raise BucketError("this main holds no master key")
    key = unwrap_any(store.keys, parse_header(head), artifact_context(artifact_id))
    return base64.b64encode(key).decode()


def signed_files(session: Session, store: ArtifactStore, model: BaseModel) -> list[dict[str, Any]]:
    remote = store.remote
    missing = missing_objects(session, model)
    if remote is None or missing:
        raise BucketError(f"{model.name} is missing {', '.join(sorted(missing)[:3])} in the bucket; repair it")
    return [
        file_entry(entry)
        | {
            "url": remote.sign(str(entry["sha256"]), PRESIGN_SECONDS),
            "key": data_key(store, str(entry["sha256"])),
        }
        for entry in model.files
    ]


def live_bases(session: Session) -> dict[str, str | None]:
    models = session.scalars(select(BaseModel).where(BaseModel.status == BaseModelStatus.AVAILABLE))
    return {model.id: content_hash(model.files) for model in models}


def referenced(session: Session, skip: str | None = None) -> set[str]:
    query = select(BaseModel) if skip is None else select(BaseModel).where(BaseModel.id != skip)
    return {str(entry["sha256"]) for model in session.scalars(query) for entry in model.files if entry.get("sha256")}


def drop_objects(session: Session, store: ArtifactStore, ids: set[str]) -> int:
    dropped = 0
    for artifact_id in sorted(ids):
        found = session.get(Artifact, artifact_id)
        if found is None or found.kind != WEIGHTS:
            continue
        session.delete(found)
        store.delete(artifact_id)
        dropped += 1
    return dropped


def drop_weights(session: Session, store: ArtifactStore, model: BaseModel) -> int:
    return drop_objects(session, store, set(hashes_of(model)) - referenced(session, skip=model.id))


def transfers_running(session: Session) -> bool:
    kinds = (JobKind.DOWNLOAD, JobKind.IMPORT, JobKind.REPAIR)
    query = select(Job.id).where(Job.kind.in_(kinds), Job.status.in_(ACTIVE_JOB_STATUSES)).limit(1)
    return session.scalar(query) is not None


def sweep_weights(session: Session, store: ArtifactStore) -> int:
    if transfers_running(session):
        return 0
    stored = set(session.scalars(select(Artifact.id).where(Artifact.kind == WEIGHTS)))
    return drop_objects(session, store, stored - referenced(session))
