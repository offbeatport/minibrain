from dataclasses import asdict, dataclass, replace
from typing import Any

from sqlalchemy.orm import Session

from minibrain.registry.settings_store import read, write

KEY = "data.limits"


@dataclass(frozen=True)
class DataLimits:
    row_limit: int = 200_000
    keep_snapshots: int = 5


def load_limits(session: Session) -> DataLimits:
    stored = read(session, KEY, {}) or {}
    known = {name: stored[name] for name in asdict(DataLimits()) if name in stored}
    return replace(DataLimits(), **known)


def save_limits(session: Session, changes: dict[str, Any]) -> DataLimits:
    updated = replace(load_limits(session), **changes)
    write(session, KEY, asdict(updated))
    return updated
