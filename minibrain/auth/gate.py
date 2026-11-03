import ipaddress
from dataclasses import dataclass, field
from typing import Literal

from sqlalchemy.orm import Session

from minibrain.auth.accounts import live_session, person_of, users_exist
from minibrain.auth.identity import LOCAL_PERSON, Person

FORWARDED_HEADERS = ("forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip")
Reason = Literal["listen", "remote"]


@dataclass(frozen=True)
class RequestFacts:
    path: str
    method: str
    token: str | None = None
    csrf: str | None = None
    server: str | None = None
    client: str | None = None
    user_agent: str | None = None
    forwarded: bool = False
    headers: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class Identity:
    person: Person | None
    accounts: bool
    users: bool
    csrf_subject: str | None = None
    reason: Reason | None = None


def ip_of(host: str | None) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    if not host:
        return None
    try:
        found = ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        return None
    if isinstance(found, ipaddress.IPv6Address) and found.ipv4_mapped is not None:
        return found.ipv4_mapped
    return found


def loopback_name(host: str | None) -> bool:
    if not host:
        return False
    lowered = host.lower().rstrip(".")
    if lowered == "localhost" or lowered.endswith(".localhost"):
        return True
    found = ip_of(lowered)
    return found is not None and found.is_loopback


def reached_locally(listen: str, facts: RequestFacts) -> bool:
    if not loopback_name(listen) or facts.forwarded:
        return False
    for host in (facts.server, facts.client):
        found = ip_of(host)
        if found is not None and not found.is_loopback:
            return False
    return True


def identify(session: Session, listen: str, accounts_known: bool, facts: RequestFacts) -> Identity:
    if facts.token:
        row = live_session(session, facts.token)
        if row is not None:
            person = person_of(row.user)
            return Identity(person=person, accounts=True, users=True, csrf_subject=f"session:{row.token_hash}")
    users = accounts_known or users_exist(session)
    if not users and reached_locally(listen, facts):
        return Identity(person=LOCAL_PERSON, accounts=False, users=False)
    reason: Reason | None = None if users else ("listen" if not loopback_name(listen) else "remote")
    return Identity(person=None, accounts=True, users=users, reason=reason)
