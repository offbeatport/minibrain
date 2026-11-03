from collections.abc import Iterator
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.registry.models import Dataset, DatasetFolder
from minibrain.registry.service import ConflictError, NotFoundError

ROOT = "Datasets"


@dataclass(frozen=True)
class Removal:
    folders: int
    datasets: int
    renamed: list[str]


def get_folder(session: Session, folder_id: int) -> DatasetFolder:
    folder = session.get(DatasetFolder, folder_id)
    if folder is None:
        raise NotFoundError(f"no folder {folder_id}")
    return folder


def folder_or_root(session: Session, folder_id: int | None) -> DatasetFolder | None:
    return None if folder_id is None else get_folder(session, folder_id)


def list_folders(session: Session) -> list[DatasetFolder]:
    return list(session.scalars(select(DatasetFolder).order_by(DatasetFolder.name, DatasetFolder.id)))


def children_of(session: Session, parent_id: int | None) -> list[DatasetFolder]:
    return list(session.scalars(select(DatasetFolder).where(DatasetFolder.parent_id == parent_id)))


def ancestors(session: Session, folder: DatasetFolder | None) -> Iterator[DatasetFolder]:
    seen: set[int] = set()
    while folder is not None and folder.id not in seen:
        seen.add(folder.id)
        yield folder
        folder = folder_or_root(session, folder.parent_id)


def path_of(session: Session, folder: DatasetFolder | None) -> str:
    return "/" + "/".join(reversed([found.name for found in ancestors(session, folder)]))


def place_name(folder: DatasetFolder | None) -> str:
    return ROOT if folder is None else folder.name


def require_free_name(
    session: Session, name: str, parent: DatasetFolder | None, keep: DatasetFolder | None = None
) -> None:
    wanted = name.casefold()
    for sibling in children_of(session, parent.id if parent is not None else None):
        if sibling is not keep and sibling.name.casefold() == wanted:
            raise ConflictError(f"{place_name(parent)} already has a folder called {sibling.name}")


def free_name(name: str, taken: set[str]) -> str:
    candidates = (name if number == 1 else f"{name} {number}" for number in range(1, 10_000))
    return next(candidate for candidate in candidates if candidate.casefold() not in taken)


def create_folder(session: Session, name: str, parent_id: int | None) -> DatasetFolder:
    parent = folder_or_root(session, parent_id)
    require_free_name(session, name, parent)
    folder = DatasetFolder(name=name, parent_id=parent_id)
    session.add(folder)
    session.flush()
    return folder


def rename_folder(session: Session, folder: DatasetFolder, name: str) -> None:
    require_free_name(session, name, folder_or_root(session, folder.parent_id), keep=folder)
    folder.name = name


def move_folder(session: Session, folder: DatasetFolder, parent_id: int | None) -> None:
    parent = folder_or_root(session, parent_id)
    if any(found.id == folder.id for found in ancestors(session, parent)):
        raise ConflictError(f"{folder.name} cannot go inside itself or one of its own folders")
    require_free_name(session, folder.name, parent, keep=folder)
    folder.parent_id = parent_id


def delete_folder(session: Session, folder: DatasetFolder) -> Removal:
    parent_id = folder.parent_id
    taken = {sibling.name.casefold() for sibling in children_of(session, parent_id) if sibling is not folder}
    renamed: list[str] = []
    subfolders = children_of(session, folder.id)
    for child in subfolders:
        name = free_name(child.name, taken)
        taken.add(name.casefold())
        if name != child.name:
            renamed.append(f"{child.name} → {name}")
        child.name = name
        child.parent_id = parent_id
    datasets = list(session.scalars(select(Dataset).where(Dataset.folder_id == folder.id)))
    for dataset in datasets:
        dataset.folder_id = parent_id
    session.flush()
    session.delete(folder)
    session.flush()
    return Removal(folders=len(subfolders), datasets=len(datasets), renamed=renamed)


def move_dataset(session: Session, dataset: Dataset, folder_id: int | None) -> None:
    dataset.folder_id = None if folder_id is None else get_folder(session, folder_id).id
