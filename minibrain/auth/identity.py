from contextvars import ContextVar
from dataclasses import dataclass

from minibrain.auth.roles import Role


@dataclass(frozen=True)
class Person:
    id: int
    name: str
    email: str | None
    source: str
    role: Role | None
    role_locked: bool = False

    @property
    def actor(self) -> str:
        return self.email or self.name


CURRENT: ContextVar[Person | None] = ContextVar("person", default=None)


class NobodySignedIn(LookupError):
    pass


def current_person() -> Person | None:
    return CURRENT.get()


def current_actor() -> str:
    person = CURRENT.get()
    if person is None:
        raise NobodySignedIn("No one is signed in")
    return person.actor


def current_role() -> Role | None:
    person = CURRENT.get()
    return person.role if person is not None else None
