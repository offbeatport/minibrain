from pathlib import Path
from typing import Any

from fastapi import HTTPException, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from minibrain.artifacts import ArtifactStore
from minibrain.models.bucket import BucketError, live_bases, signed_files
from minibrain.models.copies import BUCKET, FOLDER
from minibrain.models.health import content_hash
from minibrain.models.registry import resolve_spec
from minibrain.registry.models import Model, ModelStatus
from minibrain.serve.weights import local_dir
from minibrain.settings import Settings

NO_STORE = {"Cache-Control": "no-store"}


class BaseFile(BaseModel):
    path: str
    size: int
    sha256: str | None = None
    url: str | None = None
    key: str | None = None


class BaseWeights(BaseModel):
    spec: dict[str, Any]
    store: str = FOLDER
    content_hash: str | None = None
    files: list[BaseFile]


class LiveBases(BaseModel):
    bases: dict[str, str | None]


def weights_folder(session: Session, settings: Settings, key: str) -> tuple[dict[str, Any], Path]:
    spec = resolve_spec(session, settings, key)
    try:
        return spec.as_dict(), local_dir(spec, offline=True).resolve()
    except Exception as error:
        raise HTTPException(status_code=404, detail=f"weights for {key} are not on main") from error


def listed_files(folder: Path) -> list[BaseFile]:
    return [
        BaseFile(path=path.relative_to(folder).as_posix(), size=path.stat().st_size)
        for path in sorted(folder.rglob("*"))
        if path.is_file() and not any(part.startswith(".") for part in path.relative_to(folder).parts)
    ]


def shareable(session: Session, key: str, folder: Path) -> list[BaseFile]:
    model = session.get(Model, key)
    if model is None or not model.files:
        return listed_files(folder)
    return [
        BaseFile(path=str(entry["path"]), size=int(entry["size"]), sha256=entry.get("sha256")) for entry in model.files
    ]


def in_bucket(session: Session, key: str) -> Model | None:
    model = session.get(Model, key)
    if model is None or model.store != BUCKET or model.status != ModelStatus.AVAILABLE:
        return None
    return model


def base_weights(
    session: Session, settings: Settings, store: ArtifactStore, key: str, response: Response
) -> BaseWeights:
    model = in_bucket(session, key)
    if model is None:
        spec, folder = weights_folder(session, settings, key)
        found = session.get(Model, key)
        content = content_hash(found.files) if found is not None else None
        return BaseWeights(spec=spec | {"path": None}, content_hash=content, files=shareable(session, key, folder))
    try:
        files = signed_files(session, store, model)
    except BucketError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    response.headers.update(NO_STORE)
    spec = resolve_spec(session, settings, key).as_dict() | {"path": None}
    return BaseWeights(
        spec=spec, store=BUCKET, content_hash=content_hash(model.files), files=[BaseFile(**item) for item in files]
    )


def base_file(session: Session, settings: Settings, key: str, path: str) -> FileResponse:
    if in_bucket(session, key) is not None:
        raise HTTPException(status_code=404, detail=f"{key} is in the bucket; fetch its files from there")
    _, folder = weights_folder(session, settings, key)
    candidate = (folder / path).resolve()
    known = {entry.path for entry in shareable(session, key, folder)}
    if path not in known or not candidate.is_file() or not candidate.is_relative_to(folder):
        raise HTTPException(status_code=404, detail=f"{path} is not part of {key}")
    return FileResponse(candidate)


def live(session: Session) -> LiveBases:
    return LiveBases(bases=live_bases(session))
