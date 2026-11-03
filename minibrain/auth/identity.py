from contextvars import ContextVar
from dataclasses import dataclass

from minibrain.auth.roles import Role

LOCAL_USER = "Local user"
SINGLE_USER = "single_user"


@dataclass(frozen=True)
class Person:
    id: int | None
    name: str
    email: str | None
    source: str
    role: Role | None
    role_locked: bool = False

    @property
    def actor(self) -> str:
        return LOCAL_USER if self.source == SINGLE_USER else self.email or self.name

    @property
    def signed_in(self) -> bool:
        return self.source != SINGLE_USER


LOCAL_PERSON = Person(id=None, name=LOCAL_USER, email=None, source=SINGLE_USER, role=Role.ADMIN)
CURRENT: ContextVar[Person | None] = ContextVar("person", default=None)


def current_person() -> Person | None:
    return CURRENT.get()


def current_actor() -> str:
    person = CURRENT.get()
    return person.actor if person is not None else LOCAL_USER


def current_role() -> Role | None:
    person = CURRENT.get()
    return person.role if person is not None else Role.ADMIN
