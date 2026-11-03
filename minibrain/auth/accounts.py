import hashlib
import hmac
import re
import secrets
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from minibrain import policy
from minibrain.auth.identity import Person
from minibrain.auth.passwords import check_strength, hash_password, verify_password
from minibrain.auth.roles import Role, role_of
from minibrain.registry.models import LoginSession, Setting, User, now
from minibrain.registry.service import ConflictError, NotFoundError
from minibrain.registry.settings_store import read, write

SESSION_COOKIE = "minibrain_session"
CSRF_HEADER = "x-csrf-token"
CSRF_KEY = "auth.csrf_key"
FIRST_ADMIN = "auth.first_admin"
LOCAL = "local"
OIDC = "oidc"
PROXY = "proxy"
TOKEN_BYTES = 32
RESET_LIFETIME = timedelta(hours=24)
LOCK_AFTER = 10
LOCK_LIFETIME = timedelta(minutes=15)
TOUCH_EVERY = timedelta(seconds=60)
AGENT_LENGTH = 300
NAME_LENGTH = 200
EMAIL = re.compile(r"[^@\s]+@[^@\s]+")
WRONG = "Wrong email or password"
TAKEN = "This install already has an admin account; sign in instead"


class AccountError(Exception):
    pass


class SignInError(Exception):
    pass


@dataclass(frozen=True)
class Lifetimes:
    idle: timedelta | None
    absolute: timedelta


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_token() -> str:
    return secrets.token_urlsafe(TOKEN_BYTES)


def normal_email(email: str) -> str:
    cleaned = email.strip().lower()
    if len(cleaned) > NAME_LENGTH or not EMAIL.fullmatch(cleaned):
        raise AccountError("Enter an email address")
    return cleaned


def clean_name(name: str, fallback: str) -> str:
    return " ".join(name.split())[:NAME_LENGTH] or fallback


def users_exist(session: Session) -> bool:
    return session.scalar(select(User.id).limit(1)) is not None


def get_user(session: Session, user_id: int) -> User:
    user = session.get(User, user_id)
    if user is None:
        raise NotFoundError(f"No account {user_id}")
    return user


def find_local(session: Session, email: str) -> User | None:
    return session.scalar(select(User).where(User.source == LOCAL, User.subject == email))


def create_local(session: Session, email: str, name: str, role: Role, password: str | None = None) -> User:
    address = normal_email(email)
    if find_local(session, address) is not None:
        raise ConflictError(f"{address} already has an account")
    if password is not None:
        check_strength(password)
    user = User(
        email=address,
        name=clean_name(name, address),
        source=LOCAL,
        subject=address,
        role=role.value,
        groups=[],
        disabled=False,
        password_hash=hash_password(password) if password is not None else None,
        failed_sign_ins=0,
    )
    session.add(user)
    session.flush()
    return user


def claim_first_admin(session: Session) -> None:
    if users_exist(session) or session.get(Setting, FIRST_ADMIN) is not None:
        raise ConflictError(TAKEN)
    session.add(Setting(key=FIRST_ADMIN, value=True, updated_at=now()))


def commit_first_admin(session: Session) -> None:
    try:
        session.commit()
    except IntegrityError as error:
        session.rollback()
        raise ConflictError(TAKEN) from error


def enabled_admins(session: Session) -> int:
    query = select(func.count(User.id)).where(User.role == Role.ADMIN.value, User.disabled.is_(False))
    return int(session.scalar(query) or 0)


def lifetimes(session: Session) -> Lifetimes:
    idle = int(policy.value(session, "session_idle_minutes"))
    hours = int(policy.value(session, "session_hours"))
    return Lifetimes(idle=timedelta(minutes=idle) if idle else None, absolute=timedelta(hours=hours))


def start_session(session: Session, user: User, ip: str | None, user_agent: str | None) -> tuple[LoginSession, str]:
    token = new_token()
    moment = now()
    row = LoginSession(
        user_id=user.id,
        token_hash=token_digest(token),
        created_at=moment,
        last_seen_at=moment,
        expires_at=moment + lifetimes(session).absolute,
        ip=ip,
        user_agent=(user_agent or "")[:AGENT_LENGTH] or None,
    )
    session.add(row)
    user.last_sign_in_at = moment
    session.flush()
    return row, token


def live_session(session: Session, token: str) -> LoginSession | None:
    row = session.scalar(select(LoginSession).where(LoginSession.token_hash == token_digest(token)))
    if row is None:
        return None
    moment = now()
    limits = lifetimes(session)
    ends = min(row.expires_at, row.created_at + limits.absolute)
    idle = limits.idle is not None and moment - row.last_seen_at > limits.idle
    if ends <= moment or idle or row.user.disabled:
        session.delete(row)
        return None
    if moment - row.last_seen_at > TOUCH_EVERY:
        row.last_seen_at = moment
    return row


def end_session(session: Session, token: str) -> None:
    session.execute(delete(LoginSession).where(LoginSession.token_hash == token_digest(token)))


def end_sessions(session: Session, user: User) -> None:
    session.execute(delete(LoginSession).where(LoginSession.user_id == user.id))


def ensure_csrf_key(session: Session) -> bytes:
    stored = read(session, CSRF_KEY)
    if not stored:
        stored = secrets.token_hex(32)
        write(session, CSRF_KEY, stored)
    return bytes.fromhex(stored)


def csrf_for(key: bytes, subject: str) -> str:
    return hmac.new(key, subject.encode(), hashlib.sha256).hexdigest()


def csrf_matches(key: bytes, subject: str, given: str | None) -> bool:
    return given is not None and hmac.compare_digest(csrf_for(key, subject), given)


def sign_in(session: Session, email: str, password: str) -> User:
    try:
        address = normal_email(email)
    except AccountError as error:
        raise SignInError(WRONG) from error
    user = find_local(session, address)
    moment = now()
    if user is not None and user.locked_until is not None and user.locked_until > moment:
        verify_password(password, None)
        minutes = max(1, round((user.locked_until - moment).total_seconds() / 60))
        raise SignInError(f"Too many failed sign-ins. Try again in {minutes} minutes.")
    if user is None or not verify_password(password, user.password_hash):
        if user is not None:
            user.failed_sign_ins += 1
            if user.failed_sign_ins >= LOCK_AFTER:
                user.locked_until = moment + LOCK_LIFETIME
                user.failed_sign_ins = 0
        raise SignInError(WRONG)
    if user.disabled:
        raise SignInError("This account is turned off. Ask an admin to turn it back on.")
    user.failed_sign_ins = 0
    user.locked_until = None
    return user


def issue_reset(user: User) -> str:
    if user.source != LOCAL:
        raise AccountError("Only local accounts have a password in minibrain")
    if user.disabled:
        raise AccountError("Turn the account on before sending it a password link")
    token = new_token()
    user.reset_hash = token_digest(token)
    user.reset_expires_at = now() + RESET_LIFETIME
    user.updated_at = now()
    return token


def redeem_reset(session: Session, token: str, password: str) -> User:
    user = session.scalar(select(User).where(User.reset_hash == token_digest(token)))
    expired = user is None or user.reset_expires_at is None or user.reset_expires_at <= now()
    if user is None or expired or user.disabled:
        raise AccountError("This link has expired or was already used. Ask an admin for a new one.")
    check_strength(password)
    user.password_hash = hash_password(password)
    user.reset_hash = None
    user.reset_expires_at = None
    user.failed_sign_ins = 0
    user.locked_until = None
    user.updated_at = now()
    end_sessions(session, user)
    return user


def person_of(user: User, role: Role | None = None, locked: bool = False) -> Person:
    return Person(
        id=user.id,
        name=user.name,
        email=user.email,
        source=user.source,
        role=role if locked else role_of(user.role),
        role_locked=locked,
    )
