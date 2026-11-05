from dataclasses import asdict, dataclass, replace
from typing import Any

from sqlalchemy.orm import Session

from minibrain import provision
from minibrain.data.checks import CheckLimits
from minibrain.registry.settings_store import read, write

KEY = "data.limits"
LABELS = {
    "row_limit": "Most rows in one version",
    "keep_versions": "Unused versions kept per dataset",
    "checks_off": "Version checks",
    "majority_share": "The label share that warns",
    "min_label_rows": "The fewest rows per label",
}


@dataclass(frozen=True)
class DataLimits:
    row_limit: int = 200_000
    keep_versions: int = 5
    checks_off: tuple[str, ...] = ()
    majority_share: float = 0.9
    min_label_rows: int = 10

    def checks(self) -> CheckLimits:
        return CheckLimits(
            off=tuple(self.checks_off), majority_share=self.majority_share, min_label_rows=self.min_label_rows
        )


def as_limits(known: dict[str, Any]) -> DataLimits:
    if "checks_off" in known:
        known = known | {"checks_off": tuple(sorted(set(known["checks_off"])))}
    return replace(DataLimits(), **known)


def stored_limits(session: Session) -> DataLimits:
    stored = read(session, KEY, {}) or {}
    return as_limits({name: stored[name] for name in asdict(DataLimits()) if name in stored})


def load_limits(session: Session) -> DataLimits:
    return as_limits(asdict(stored_limits(session)) | provision.provided("data").values)


def save_limits(session: Session, changes: dict[str, Any]) -> DataLimits:
    found = provision.provided("data")
    current = asdict(load_limits(session))
    wanted = asdict(as_limits(current | changes))
    for name in changes:
        if found.source(name) and wanted[name] != current[name]:
            found.refuse(name, LABELS[name])
    own = {name: value for name, value in changes.items() if not found.source(name)}
    updated = as_limits(asdict(stored_limits(session)) | own)
    write(session, KEY, asdict(updated) | {"checks_off": list(updated.checks_off)})
    return load_limits(session)
