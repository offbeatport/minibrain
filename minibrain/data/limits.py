from dataclasses import asdict, dataclass, replace
from typing import Any

from sqlalchemy.orm import Session

from minibrain.data.checks import CheckLimits
from minibrain.registry.settings_store import read, write

KEY = "data.limits"


@dataclass(frozen=True)
class DataLimits:
    row_limit: int = 200_000
    keep_snapshots: int = 5
    checks_off: tuple[str, ...] = ()
    majority_share: float = 0.9
    min_label_rows: int = 10

    def checks(self) -> CheckLimits:
        return CheckLimits(
            off=tuple(self.checks_off), majority_share=self.majority_share, min_label_rows=self.min_label_rows
        )


def load_limits(session: Session) -> DataLimits:
    stored = read(session, KEY, {}) or {}
    known = {name: stored[name] for name in asdict(DataLimits()) if name in stored}
    if "checks_off" in known:
        known["checks_off"] = tuple(known["checks_off"])
    return replace(DataLimits(), **known)


def save_limits(session: Session, changes: dict[str, Any]) -> DataLimits:
    if "checks_off" in changes:
        changes = changes | {"checks_off": tuple(sorted(set(changes["checks_off"])))}
    updated = replace(load_limits(session), **changes)
    write(session, KEY, asdict(updated) | {"checks_off": list(updated.checks_off)})
    return updated
