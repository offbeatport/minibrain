from typing import Any

from fastapi import APIRouter
from sqlalchemy.orm import Session

from minibrain.api.data import dataset_summary
from minibrain.api.deps import SessionDep, SettingsDep, StoreDep
from minibrain.api.schemas import (
    DatasetFolderChoice,
    DatasetFolderCreate,
    DatasetFolderInfo,
    DatasetFolderParent,
    DatasetFolderRename,
    DatasetSummary,
)
from minibrain.auth.identity import current_actor
from minibrain.data.dataset_folders import (
    create_folder,
    delete_folder,
    folder_or_root,
    get_folder,
    list_folders,
    move_dataset,
    move_folder,
    path_of,
    rename_folder,
)
from minibrain.data.shared import get_dataset
from minibrain.registry.models import AuditEvent, DatasetFolder

router = APIRouter(prefix="/api", tags=["data"])


def folder_info(folder: DatasetFolder) -> DatasetFolderInfo:
    return DatasetFolderInfo(id=folder.id, name=folder.name, parent_id=folder.parent_id, created_at=folder.created_at)


def audit(session: Session, action: str, target: str, detail: dict[str, Any]) -> None:
    session.add(AuditEvent(actor=current_actor(), action=action, target=target, detail=detail))


def folder_target(folder: DatasetFolder) -> str:
    return f"dataset_folder:{folder.id}"


@router.get("/dataset-folders")
def read_folders(session: SessionDep) -> list[DatasetFolderInfo]:
    return [folder_info(folder) for folder in list_folders(session)]


@router.post("/dataset-folders", status_code=201)
def add_folder(body: DatasetFolderCreate, session: SessionDep) -> DatasetFolderInfo:
    folder = create_folder(session, body.name, body.parent_id)
    detail = {"name": folder.name, "path": path_of(session, folder)}
    audit(session, "dataset_folder.create", folder_target(folder), detail)
    session.commit()
    return folder_info(folder)


@router.patch("/dataset-folders/{folder_id}")
def rename(folder_id: int, body: DatasetFolderRename, session: SessionDep) -> DatasetFolderInfo:
    folder = get_folder(session, folder_id)
    before = folder.name
    rename_folder(session, folder, body.name)
    if folder.name != before:
        detail = {"name": folder.name, "from": before, "to": folder.name}
        audit(session, "dataset_folder.rename", folder_target(folder), detail)
    session.commit()
    return folder_info(folder)


@router.put("/dataset-folders/{folder_id}/parent")
def move(folder_id: int, body: DatasetFolderParent, session: SessionDep) -> DatasetFolderInfo:
    folder = get_folder(session, folder_id)
    if body.parent_id != folder.parent_id:
        before = path_of(session, folder)
        move_folder(session, folder, body.parent_id)
        detail = {"name": folder.name, "from": before, "to": path_of(session, folder)}
        audit(session, "dataset_folder.move", folder_target(folder), detail)
    session.commit()
    return folder_info(folder)


@router.delete("/dataset-folders/{folder_id}", status_code=204)
def remove(folder_id: int, session: SessionDep) -> None:
    folder = get_folder(session, folder_id)
    target, name, path = folder_target(folder), folder.name, path_of(session, folder)
    removal = delete_folder(session, folder)
    detail: dict[str, Any] = {"name": name, "path": path, "folders": removal.folders, "datasets": removal.datasets}
    if removal.renamed:
        detail["renamed"] = removal.renamed
    audit(session, "dataset_folder.delete", target, detail)
    session.commit()


@router.put("/datasets/{slug}/folder")
def place_dataset(
    slug: str, body: DatasetFolderChoice, session: SessionDep, settings: SettingsDep, store: StoreDep
) -> DatasetSummary:
    dataset = get_dataset(session, slug)
    if body.folder_id != dataset.folder_id:
        before = path_of(session, folder_or_root(session, dataset.folder_id))
        move_dataset(session, dataset, body.folder_id)
        detail = {"name": dataset.name, "from": before, "to": path_of(session, folder_or_root(session, body.folder_id))}
        audit(session, "dataset.move", f"dataset:{dataset.slug}", detail)
    session.commit()
    return dataset_summary(settings, store, dataset)
