from typing import Any

from sqlalchemy.orm import Session

from minibrain.registry.models import Setting, now


def read(session: Session, key: str, default: Any = None) -> Any:
    found = session.get(Setting, key)
    return default if found is None else found.value


def write(session: Session, key: str, value: Any) -> None:
    found = session.get(Setting, key)
    if found is None:
        session.add(Setting(key=key, value=value, updated_at=now()))
    else:
        found.value = value
        found.updated_at = now()
