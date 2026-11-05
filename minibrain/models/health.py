import hashlib
import logging
from collections.abc import Callable
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.registry.models import BaseModel, BaseModelStatus, now

CORRUPT = "corrupt"
MISSING = "missing"
WRONG_SIZE = "wrong_size"
NO_SPACE = "no_space"
NEEDS_ACCESS = "needs_access"
SOURCE_GONE = "source_gone"
OFFLINE = "offline"
CANT_RUN = "cant_run"
NO_MEMORY = "no_memory"
LOAD_PROBLEMS = frozenset({CANT_RUN, NO_MEMORY})

log = logging.getLogger("minibrain.models")


def content_hash(files: list[dict[str, Any]]) -> str | None:
    if not files or any(not entry.get("sha256") for entry in files):
        return None
    lines = sorted(f"{entry['path']}\t{entry['size']}\t{entry['sha256']}" for entry in files)
    return hashlib.sha256("\n".join(lines).encode()).hexdigest()


def size_problems(folder: Path, files: list[dict[str, Any]]) -> dict[str, str]:
    found: dict[str, str] = {}
    for entry in files:
        target = folder / str(entry["path"])
        if not target.is_file():
            found[str(entry["path"])] = MISSING
        elif target.stat().st_size != int(entry["size"]):
            found[str(entry["path"])] = WRONG_SIZE
    return found


def listed(paths: list[str], limit: int = 3) -> str:
    shown = ", ".join(paths[:limit])
    return f"{shown} and {len(paths) - limit} more" if len(paths) > limit else shown


def verb(paths: list[str], one: str, many: str) -> str:
    return one if len(paths) == 1 else many


def missing_message(problems: dict[str, str]) -> str:
    paths = sorted(problems)
    return f"{listed(paths)} {verb(paths, 'is', 'are')} missing or the wrong size"


def set_health(model: BaseModel, state: str | None, message: str | None = None, **detail: Any) -> None:
    model.health = state
    model.health_detail = {"message": message, **detail} if state else {}
    model.updated_at = now()


def file_states(model: BaseModel) -> dict[str, str]:
    return dict((model.health_detail or {}).get("files") or {})


def apply_check(model: BaseModel, checked: list[dict[str, Any]]) -> None:
    states = {entry["path"]: entry["status"] for entry in checked if entry["status"] != "ok"}
    hashes = {entry["path"]: entry.get("sha256") for entry in checked if entry["status"] == "ok"}
    model.files = [entry | {"sha256": entry.get("sha256") or hashes.get(entry["path"])} for entry in model.files]
    model.verified_at = now()
    corrupt = sorted(path for path, state in states.items() if state == CORRUPT)
    if not corrupt:
        if model.health == CORRUPT:
            set_health(model, None)
        return
    message = f"{listed(corrupt)} {verb(corrupt, 'does', 'do')} not match the SHA-256 saved at install"
    others = {path: state for path, state in states.items() if state != CORRUPT}
    if others:
        message += f"; {missing_message(others)}"
    set_health(model, CORRUPT, message + ".", files=states)


def apply_repair(model: BaseModel, recorded: list[dict[str, Any]]) -> None:
    hashes = {entry["path"]: entry.get("sha256") for entry in recorded}
    model.files = [entry | {"sha256": entry.get("sha256") or hashes.get(entry["path"])} for entry in model.files]
    model.verified_at = now()
    if model.health == CORRUPT:
        set_health(model, None)


def problem_of(model: BaseModel, problems: dict[str, str]) -> str | None:
    if model.status != BaseModelStatus.AVAILABLE:
        return None
    if model.health:
        message = (model.health_detail or {}).get("message")
        return f"{model.name} cannot be loaded: {message or model.health}"
    if problems:
        return f"{model.name} cannot be loaded: {missing_message(problems)}. Repair it on the Models page."
    return None


def record_load_failure(session: Session, key: str, code: str | None, message: str | None, host: str) -> None:
    model = session.get(BaseModel, key)
    if model is None or code not in LOAD_PROBLEMS:
        return
    if model.health == code and (model.health_detail or {}).get("message") == message:
        return
    set_health(model, code, message, host=host)


def record_loaded(session: Session, key: str) -> None:
    model = session.get(BaseModel, key)
    if model is not None and model.health in LOAD_PROBLEMS:
        set_health(model, None)


def report_problems(session: Session, problems_of: Callable[[BaseModel], dict[str, str]]) -> int:
    found = 0
    for model in session.scalars(select(BaseModel).where(BaseModel.status == BaseModelStatus.AVAILABLE)):
        problem = problem_of(model, problems_of(model))
        if problem is not None:
            found += 1
            log.warning("%s", problem)
    return found


def base_changed(target: str, base: str, trained: str | None, current: str | None) -> str | None:
    if not trained or not current or trained == current:
        return None
    return (
        f"{target} was trained on {base} with files {trained[:12]}; {base} now has files {current[:12]}. "
        f"It will not load against them: restore {base}'s original files or train a new version."
    )
