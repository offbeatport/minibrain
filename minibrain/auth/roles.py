from collections.abc import Iterable
from enum import StrEnum


class Role(StrEnum):
    VIEWER = "viewer"
    BUILDER = "builder"
    ADMIN = "admin"


RANK = {Role.VIEWER: 1, Role.BUILDER: 2, Role.ADMIN: 3}
LABELS = {Role.VIEWER: "Viewer", Role.BUILDER: "Builder", Role.ADMIN: "Admin"}


def role_of(value: str | None) -> Role | None:
    if value is None:
        return None
    try:
        return Role(value.strip().lower())
    except ValueError:
        return None


def allows(role: Role | None, needed: Role) -> bool:
    return role is not None and RANK[role] >= RANK[needed]


def highest(roles: Iterable[Role]) -> Role | None:
    return max(roles, key=RANK.__getitem__, default=None)
