from dataclasses import dataclass, field
from datetime import timedelta
from typing import Literal

from sqlalchemy.orm import Session

from minibrain.auth.accounts import (
    NAME_LENGTH,
    PROXY,
    TURNED_OFF,
    external_user,
    groups_of,
    live_session,
    person_for,
    users_exist,
)
from minibrain.auth.addresses import ip_of, loopback_name
from minibrain.auth.config import AuthConfig
from minibrain.auth.identity import LOCAL_PERSON, Person
from minibrain.registry.models import AuditEvent, now

FORWARDED_HEADERS = ("forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip")
Reason = Literal["listen", "remote"]
PROXY_SIGN_IN_GAP = timedelta(minutes=30)


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
    via_proxy: bool = False
    headers: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class Identity:
    person: Person | None
    accounts: bool
    users: bool
    csrf_subject: str | None = None
    reason: Reason | None = None
    refused: str | None = None


def reached_locally(listen: str, facts: RequestFacts) -> bool:
    if not loopback_name(listen) or facts.forwarded:
        return False
    for host in (facts.server, facts.client):
        found = ip_of(host)
        if found is not None and not found.is_loopback:
            return False
    return True


def proxy_identity(session: Session, config: AuthConfig, facts: RequestFacts) -> Identity | None:
    proxy = config.proxy
    if proxy is None or not facts.via_proxy:
        return None
    subject = facts.headers.get(proxy.user_header, "").strip()[:NAME_LENGTH]
    if not subject:
        return None
    email = facts.headers.get(proxy.email_header)
    name = facts.headers.get(proxy.name_header)
    user, created = external_user(
        session, PROXY, subject, email, name, groups_of(facts.headers.get(proxy.groups_header))
    )
    if user.disabled:
        return Identity(person=None, accounts=True, users=True, refused=TURNED_OFF)
    person = person_for(session, user, config)
    if created:
        detail = {"name": user.name, "source": PROXY, "groups": list(user.groups or [])}
        session.add(AuditEvent(actor=person.actor, action="account.create", target=person.actor, detail=detail))
    moment = now()
    if user.last_sign_in_at is None or moment - user.last_sign_in_at > PROXY_SIGN_IN_GAP:
        user.last_sign_in_at = moment
        session.add(
            AuditEvent(actor=person.actor, action="auth.sign_in", target=person.actor, detail={"sign_in": PROXY})
        )
    return Identity(person=person, accounts=True, users=True, csrf_subject=f"proxy:{user.id}")


def identify(session: Session, listen: str, accounts_known: bool, facts: RequestFacts, config: AuthConfig) -> Identity:
    proxied = proxy_identity(session, config, facts)
    if proxied is not None:
        return proxied
    if facts.token:
        row = live_session(session, facts.token)
        if row is not None:
            person = person_for(session, row.user, config)
            return Identity(person=person, accounts=True, users=True, csrf_subject=f"session:{row.token_hash}")
    users = accounts_known or users_exist(session)
    if not users and not config.external and reached_locally(listen, facts):
        return Identity(person=LOCAL_PERSON, accounts=False, users=False)
    reason: Reason | None = None if users else ("listen" if not loopback_name(listen) else "remote")
    return Identity(person=None, accounts=True, users=users, reason=reason)
