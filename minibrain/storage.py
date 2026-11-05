import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

MIB = 1024**2
GIB = 1024**3
RESERVE_BYTES = GIB


@dataclass(frozen=True)
class Space:
    free: int
    total: int


def disk_space(path: Path) -> Space | None:
    for candidate in (path, *path.parents):
        if candidate.exists():
            usage = shutil.disk_usage(candidate)
            return Space(free=usage.free, total=usage.total)
    return None


def free_bytes(path: Path) -> int | None:
    space = disk_space(path)
    return space.free if space else None


def size_text(value: int) -> str:
    gib = value / GIB
    if gib >= 10:
        return f"{gib:.0f} GB"
    if gib >= 1:
        return f"{gib:.1f} GB"
    return f"{max(1, round(value / MIB))} MB"


def present_bytes(folder: Path, files: list[dict[str, Any]]) -> int:
    total = 0
    for entry in files:
        candidate = folder / str(entry["path"])
        if candidate.is_file() and candidate.stat().st_size == int(entry["size"]):
            total += int(entry["size"])
    return total


def missing_room(folder: Path, files: list[dict[str, Any]], size: int) -> str | None:
    space = disk_space(folder)
    needed = size - present_bytes(folder, files)
    if space is None or needed + RESERVE_BYTES <= space.free:
        return None
    return (
        f"Needs {size_text(needed)}; {size_text(space.free)} free on the disk that holds models ({folder}). "
        "Delete unused models or free up space."
    )


def staging_need(files: list[dict[str, Any]]) -> int:
    return 2 * max((int(entry["size"]) for entry in files), default=0)


def staging_room(folder: Path, files: list[dict[str, Any]]) -> str | None:
    space = disk_space(folder)
    needed = staging_need(files)
    if space is None or needed + RESERVE_BYTES <= space.free:
        return None
    return (
        f"Needs {size_text(needed)} on main's disk to pass the largest file to the bucket; {size_text(space.free)} "
        f"free ({folder}). Free up space on main."
    )
