from collections.abc import Iterator
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.data.names import free_name, same_name
from minibrain.registry.models import Dataset, DatasetFolder
from minibrain.registry.service import ConflictError, NameTakenError, NotFoundError

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
    siblings = children_of(session, parent.id if parent is not None else None)
    for sibling in siblings:
        if sibling is not keep and same_name(sibling.name, name):
            raise NameTakenError(
                f"{place_name(parent)} already has a folder called {sibling.name}",
                sibling.name,
                free_name(name, [found.name for found in siblings if found is not keep]),
                sibling.id,
            )


def datasets_in(session: Session, folder_id: int | None) -> list[Dataset]:
    return list(session.scalars(select(Dataset).where(Dataset.folder_id == folder_id)))


def dataset_names(session: Session, folder_id: int | None, keep: Dataset | None = None) -> list[str]:
    return [dataset.name for dataset in datasets_in(session, folder_id) if dataset is not keep]


def free_dataset_name(session: Session, name: str, folder_id: int | None) -> str:
    return free_name(name, dataset_names(session, folder_id))


def require_free_dataset_name(
    session: Session, name: str, folder: DatasetFolder | None, keep: Dataset | None = None
) -> None:
    folder_id = folder.id if folder is not None else None
    for dataset in datasets_in(session, folder_id):
        if dataset is not keep and same_name(dataset.name, name):
            raise NameTakenError(
                f"{place_name(folder)} already has a dataset called {dataset.name}",
                dataset.name,
                free_name(name, dataset_names(session, folder_id, keep)),
                dataset.slug,
            )


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


def rename_into(item: Dataset | DatasetFolder, taken: list[str]) -> list[str]:
    name = free_name(item.name, taken)
    taken.append(name)
    if name == item.name:
        return []
    before, item.name = item.name, name
    return [f"{before} → {name}"]


def delete_folder(session: Session, folder: DatasetFolder) -> Removal:
    parent_id = folder.parent_id
    renamed: list[str] = []
    subfolders = children_of(session, folder.id)
    folder_names = [sibling.name for sibling in children_of(session, parent_id) if sibling is not folder]
    for child in subfolders:
        renamed += rename_into(child, folder_names)
        child.parent_id = parent_id
    datasets = datasets_in(session, folder.id)
    names = dataset_names(session, parent_id)
    for dataset in datasets:
        renamed += rename_into(dataset, names)
        dataset.folder_id = parent_id
    session.flush()
    session.delete(folder)
    session.flush()
    return Removal(folders=len(subfolders), datasets=len(datasets), renamed=renamed)


def move_dataset(session: Session, dataset: Dataset, folder_id: int | None) -> None:
    folder = folder_or_root(session, folder_id)
    require_free_dataset_name(session, dataset.name, folder, keep=dataset)
    dataset.folder_id = folder.id if folder is not None else None
