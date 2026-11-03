from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from minibrain.api.access import admin
from minibrain.api.deps import SessionDep
from minibrain.auth.accounts import (
    LOCAL,
    AccountError,
    create_local,
    enabled_admins,
    end_sessions,
    get_user,
    issue_reset,
    person_of,
)
from minibrain.auth.identity import current_actor, current_person
from minibrain.auth.roles import Role, role_of
from minibrain.registry.models import AuditEvent, LoginSession, User, now

router = APIRouter(prefix="/api/accounts", tags=["accounts"])

RESET_PATH = "/reset-password"
NAME_LENGTH = 200
RoleChoice = Literal["viewer", "builder", "admin", "none"]


class AccountInfo(BaseModel):
    id: int
    email: str | None
    name: str
    source: str
    role: Role | None
    role_locked: bool
    groups: list[str]
    disabled: bool
    password_set: bool
    link_pending: bool
    sessions: int
    last_sign_in_at: datetime | None
    created_at: datetime


class AccountsInfo(BaseModel):
    people: list[AccountInfo]


class AccountCreate(BaseModel):
    email: str
    name: str = ""
    role: Role


class AccountUpdate(BaseModel):
    role: RoleChoice | None = None
    disabled: bool | None = None
    name: str | None = None


class PasswordLink(BaseModel):
    account: AccountInfo
    path: str
    expires_at: datetime


def session_counts(session: Session) -> dict[int, int]:
    query = select(LoginSession.user_id, func.count(LoginSession.id)).group_by(LoginSession.user_id)
    return {user_id: count for user_id, count in session.execute(query).all()}


def account_info(user: User, sessions: int) -> AccountInfo:
    person = person_of(user)
    pending = user.reset_expires_at is not None and user.reset_expires_at > now()
    return AccountInfo(
        id=user.id,
        email=user.email,
        name=user.name,
        source=user.source,
        role=person.role,
        role_locked=person.role_locked,
        groups=list(user.groups or []),
        disabled=user.disabled,
        password_set=user.password_hash is not None,
        link_pending=pending,
        sessions=sessions,
        last_sign_in_at=user.last_sign_in_at,
        created_at=user.created_at,
    )


def one_account(session: Session, user: User) -> AccountInfo:
    return account_info(user, session_counts(session).get(user.id, 0))


def cleaned(name: str | None) -> str:
    return " ".join((name or "").split())[:NAME_LENGTH]


def audit(session: Session, action: str, user: User, detail: dict[str, Any]) -> None:
    target = person_of(user).actor
    session.add(AuditEvent(actor=current_actor(), action=action, target=target, detail={"name": user.name} | detail))


def password_link(session: Session, user: User, action: str, detail: dict[str, Any]) -> PasswordLink:
    token = issue_reset(user)
    expires = user.reset_expires_at or now()
    audit(session, action, user, detail | {"link_expires_at": expires.isoformat()})
    session.commit()
    return PasswordLink(account=one_account(session, user), path=f"{RESET_PATH}#token={token}", expires_at=expires)


def is_last_admin(session: Session, user: User) -> bool:
    return user.role == Role.ADMIN.value and not user.disabled and enabled_admins(session) <= 1


@router.get("", dependencies=[Depends(admin)])
def accounts(session: SessionDep) -> AccountsInfo:
    counts = session_counts(session)
    people = session.scalars(select(User).order_by(func.lower(User.name), User.id))
    return AccountsInfo(people=[account_info(user, counts.get(user.id, 0)) for user in people])


@router.post("", status_code=201, dependencies=[Depends(admin)])
def add_account(body: AccountCreate, session: SessionDep) -> PasswordLink:
    user = create_local(session, body.email, body.name, body.role)
    return password_link(session, user, "account.create", {"role": body.role.value, "source": LOCAL})


@router.patch("/{account_id}", dependencies=[Depends(admin)])
def update_account(account_id: int, body: AccountUpdate, session: SessionDep) -> AccountInfo:
    user = get_user(session, account_id)
    me = current_person()
    before: dict[str, Any] = {}
    after: dict[str, Any] = {}
    name = cleaned(body.name)
    if name and name != user.name:
        before["name"], after["name"] = user.name, name
        user.name = name
    if body.role is not None:
        wanted = role_of(body.role)
        if person_of(user).role_locked:
            raise AccountError("This role comes from the identity provider's groups and is set in minibrain.yaml")
        if (wanted.value if wanted else None) != user.role:
            if wanted != Role.ADMIN and is_last_admin(session, user):
                raise AccountError("Keep at least one admin: give someone else the Admin role first")
            before["role"], after["role"] = user.role, wanted.value if wanted else None
            user.role = after["role"]
    if body.disabled is not None and body.disabled != user.disabled:
        if body.disabled and me is not None and me.id == user.id:
            raise AccountError("You cannot turn off your own account")
        if body.disabled and is_last_admin(session, user):
            raise AccountError("Keep at least one admin: give someone else the Admin role first")
        before["disabled"], after["disabled"] = user.disabled, body.disabled
        user.disabled = body.disabled
        if body.disabled:
            end_sessions(session, user)
    if after:
        user.updated_at = now()
        audit(session, "account.update", user, {"from": before, "to": after})
    session.commit()
    return one_account(session, user)


@router.post("/{account_id}/password-link", dependencies=[Depends(admin)])
def reset_password(account_id: int, session: SessionDep) -> PasswordLink:
    return password_link(session, get_user(session, account_id), "account.reset", {})
