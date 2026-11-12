from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from minibrain import policy
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
    person_for,
    person_of,
)
from minibrain.auth.config import AuthConfig
from minibrain.auth.identity import current_actor, current_person
from minibrain.auth.roles import Role, role_of
from minibrain.registry.models import AuditEvent, LoginSession, User, now

router = APIRouter(prefix="/api/accounts")

RESET_PATH = "/reset-password"
NAME_LENGTH = 200
ROLE_LOCKED = "This role comes from the identity provider's groups and is set in minibrain.yaml"
ADMIN_LISTED = "This person is listed in auth.admins in minibrain.yaml, so they stay an admin"
LAST_ADMIN = "Keep at least one admin: give someone else the Admin role first"
RoleChoice = Literal["viewer", "builder", "admin", "none"]


class AccountInfo(BaseModel):
    id: int
    email: str | None
    name: str
    source: str
    role: Role | None
    role_locked: bool
    admin_listed: bool = False
    groups: list[str]
    disabled: bool
    password_set: bool
    link_pending: bool
    sessions: int
    last_sign_in_at: datetime | None
    created_at: datetime


class RoleMapping(BaseModel):
    group: str
    role: Role


class AccountsInfo(BaseModel):
    people: list[AccountInfo]
    mapping: list[RoleMapping]
    default_role: RoleChoice
    default_role_locked: bool
    proxy_addresses: list[str]
    oidc_issuer: str | None


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


def auth_config(request: Request) -> AuthConfig:
    return request.app.state.auth


AuthDep = Annotated[AuthConfig, Depends(auth_config)]


def session_counts(session: Session) -> dict[int, int]:
    query = select(LoginSession.user_id, func.count(LoginSession.id)).group_by(LoginSession.user_id)
    return {user_id: count for user_id, count in session.execute(query).all()}


def account_info(session: Session, config: AuthConfig, user: User, sessions: int) -> AccountInfo:
    person = person_for(session, user, config)
    pending = user.reset_expires_at is not None and user.reset_expires_at > now()
    return AccountInfo(
        id=user.id,
        email=user.email,
        name=user.name,
        source=user.source,
        role=person.role,
        role_locked=person.role_locked,
        admin_listed=config.lists_admin(user.email, user.subject),
        groups=list(user.groups or []),
        disabled=user.disabled,
        password_set=user.password_hash is not None,
        link_pending=pending,
        sessions=sessions,
        last_sign_in_at=user.last_sign_in_at,
        created_at=user.created_at,
    )


def one_account(session: Session, config: AuthConfig, user: User) -> AccountInfo:
    return account_info(session, config, user, session_counts(session).get(user.id, 0))


def cleaned(name: str | None) -> str:
    return " ".join((name or "").split())[:NAME_LENGTH]


def audit(session: Session, action: str, user: User, detail: dict[str, Any]) -> None:
    target = person_of(user).actor
    session.add(AuditEvent(actor=current_actor(), action=action, target=target, detail={"name": user.name} | detail))


def password_link(
    session: Session, config: AuthConfig, user: User, action: str, detail: dict[str, Any]
) -> PasswordLink:
    token = issue_reset(user)
    expires = user.reset_expires_at or now()
    audit(session, action, user, detail | {"link_expires_at": expires.isoformat()})
    session.commit()
    account = one_account(session, config, user)
    return PasswordLink(account=account, path=f"{RESET_PATH}#token={token}", expires_at=expires)


def is_last_admin(session: Session, user: User) -> bool:
    return user.role == Role.ADMIN.value and not user.disabled and enabled_admins(session) <= 1


@router.get("", dependencies=[Depends(admin)], summary="List accounts")
def accounts(session: SessionDep, config: AuthDep) -> AccountsInfo:
    counts = session_counts(session)
    people = session.scalars(select(User).order_by(func.lower(User.name), User.id))
    proxy = config.proxy
    return AccountsInfo(
        people=[account_info(session, config, user, counts.get(user.id, 0)) for user in people],
        mapping=[RoleMapping(group=group, role=role) for group, role in sorted(config.roles.items())],
        default_role=policy.value(session, "default_role"),
        default_role_locked="default_role" in policy.locked_sources(),
        proxy_addresses=[str(network) for network in proxy.networks] if proxy else [],
        oidc_issuer=config.oidc.issuer if config.oidc else None,
    )


@router.post("", status_code=201, dependencies=[Depends(admin)], summary="Add an account")
def add_account(body: AccountCreate, session: SessionDep, config: AuthDep) -> PasswordLink:
    user = create_local(session, body.email, body.name, body.role)
    return password_link(session, config, user, "account.create", {"role": body.role.value, "source": LOCAL})


def change_role(session: Session, config: AuthConfig, user: User, choice: RoleChoice) -> tuple[Any, Any] | None:
    wanted = role_of(choice)
    value = wanted.value if wanted else None
    if config.lists_admin(user.email, user.subject):
        raise AccountError(ADMIN_LISTED)
    if person_for(session, user, config).role_locked:
        raise AccountError(ROLE_LOCKED)
    if value == user.role:
        return None
    if wanted != Role.ADMIN and is_last_admin(session, user):
        raise AccountError(LAST_ADMIN)
    before = user.role
    user.role = value
    return before, value


def change_disabled(session: Session, user: User, disabled: bool) -> tuple[Any, Any] | None:
    if disabled == user.disabled:
        return None
    me = current_person()
    if disabled and me is not None and me.id == user.id:
        raise AccountError("You cannot turn off your own account")
    if disabled and is_last_admin(session, user):
        raise AccountError(LAST_ADMIN)
    user.disabled = disabled
    if disabled:
        end_sessions(session, user)
    return not disabled, disabled


@router.patch("/{account_id}", dependencies=[Depends(admin)], summary="Change an account's role or status")
def update_account(account_id: int, body: AccountUpdate, session: SessionDep, config: AuthDep) -> AccountInfo:
    user = get_user(session, account_id)
    changes: dict[str, tuple[Any, Any]] = {}
    name = cleaned(body.name)
    if name and name != user.name:
        changes["name"] = (user.name, name)
        user.name = name
    if body.role is not None and (changed := change_role(session, config, user, body.role)):
        changes["role"] = changed
    if body.disabled is not None and (changed := change_disabled(session, user, body.disabled)):
        changes["disabled"] = changed
    if changes:
        user.updated_at = now()
        detail = {"from": {key: value[0] for key, value in changes.items()}}
        audit(session, "account.update", user, detail | {"to": {key: value[1] for key, value in changes.items()}})
    session.commit()
    return one_account(session, config, user)


@router.post("/{account_id}/password-link", dependencies=[Depends(admin)], summary="Make a password reset link")
def reset_password(account_id: int, session: SessionDep, config: AuthDep) -> PasswordLink:
    return password_link(session, config, get_user(session, account_id), "account.reset", {})
