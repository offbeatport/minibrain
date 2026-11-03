from dataclasses import dataclass, field
from datetime import timedelta

from sqlalchemy.orm import Session

from minibrain.auth.accounts import (
    NAME_LENGTH,
    PROXY,
    TURNED_OFF,
    external_user,
    groups_of,
    live_session,
    person_for,
)
from minibrain.auth.config import AuthConfig
from minibrain.auth.identity import Person
from minibrain.registry.models import AuditEvent, now

PROXY_SIGN_IN_GAP = timedelta(minutes=30)


@dataclass(frozen=True)
class RequestFacts:
    path: str
    method: str
    token: str | None = None
    csrf: str | None = None
    via_proxy: bool = False
    headers: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class Identity:
    person: Person | None
    csrf_subject: str | None = None
    refused: str | None = None


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
        return Identity(person=None, refused=TURNED_OFF)
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
    return Identity(person=person, csrf_subject=f"proxy:{user.id}")


def identify(session: Session, facts: RequestFacts, config: AuthConfig) -> Identity:
    proxied = proxy_identity(session, config, facts)
    if proxied is not None:
        return proxied
    if facts.token:
        row = live_session(session, facts.token)
        if row is not None:
            person = person_for(session, row.user, config)
            return Identity(person=person, csrf_subject=f"session:{row.token_hash}")
    return Identity(person=None)
