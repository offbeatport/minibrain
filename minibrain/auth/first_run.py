import hmac
import logging
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from minibrain import policy
from minibrain.auth.accounts import AccountError, create_local, new_token, token_digest, users_exist
from minibrain.auth.config import AuthConfig
from minibrain.auth.passwords import PasswordError
from minibrain.auth.roles import Role
from minibrain.registry.models import SYSTEM_ACTOR, AuditEvent, Setting
from minibrain.registry.service import ConflictError
from minibrain.registry.settings_store import read, write

SETUP_KEY = "auth.setup_token"
SETUP_PATH = "/setup"
ADMIN_EMAIL_ENV = "MINIBRAIN_ADMIN_EMAIL"
ADMIN_CREDENTIAL_ENV = "MINIBRAIN_ADMIN_PASSWORD"
ADMIN_CREDENTIAL_FILE_ENV = "MINIBRAIN_ADMIN_PASSWORD_FILE"
ENVIRONMENT = "environment"
SETUP_LINK = "setup link"
STALE_LINK = "This setup link was used or replaced. Run minibrain admin setup-link on the server for a new one."

log = logging.getLogger("minibrain")


class SetupTokenError(Exception):
    pass


class FirstRunError(Exception):
    pass


@dataclass(frozen=True)
class FirstRun:
    token: str | None = None
    waiting: bool = False
    admin: str | None = None


def sso_admin(session: Session, config: AuthConfig) -> bool:
    if not config.external:
        return False
    if Role.ADMIN in config.roles.values():
        return True
    return str(policy.value(session, "default_role")) == Role.ADMIN.value


def setup_open(session: Session, config: AuthConfig) -> bool:
    return not users_exist(session) and not sso_admin(session, config)


def setup_link(base: str, token: str) -> str:
    return f"{base.rstrip('/')}{SETUP_PATH}?token={token}"


def issue_setup_token(session: Session, actor: str) -> str:
    token = new_token()
    write(session, SETUP_KEY, {"sha256": token_digest(token)})
    session.add(AuditEvent(actor=actor, action="auth.setup_link", target=SETUP_PATH, detail={}))
    return token


def setup_pending(session: Session) -> bool:
    return session.get(Setting, SETUP_KEY) is not None


def clear_setup_token(session: Session) -> None:
    found = session.get(Setting, SETUP_KEY)
    if found is not None:
        session.delete(found)


def redeem_setup_token(session: Session, token: str) -> None:
    stored = read(session, SETUP_KEY)
    expected = stored.get("sha256") if isinstance(stored, dict) else None
    if not isinstance(expected, str) or not hmac.compare_digest(expected, token_digest(token)):
        raise SetupTokenError(STALE_LINK)
    clear_setup_token(session)


def admin_password(environ: Mapping[str, str]) -> str:
    path = environ.get(ADMIN_CREDENTIAL_FILE_ENV, "").strip()
    if path:
        try:
            return Path(path).read_text().rstrip("\r\n")
        except OSError as error:
            raise FirstRunError(f"{ADMIN_CREDENTIAL_FILE_ENV}: cannot read {path}: {error.strerror}") from error
    plain = environ.get(ADMIN_CREDENTIAL_ENV, "")
    if plain:
        log.warning(
            "%s is set: prefer %s, a file such as a Docker or Kubernetes secret, so the password stays out of "
            "the environment",
            ADMIN_CREDENTIAL_ENV,
            ADMIN_CREDENTIAL_FILE_ENV,
        )
        return plain
    raise FirstRunError(f"{ADMIN_EMAIL_ENV} is set: set {ADMIN_CREDENTIAL_FILE_ENV} to a file that holds the password")


def admin_from_environment(session: Session, email: str, environ: Mapping[str, str]) -> str:
    password = admin_password(environ)
    try:
        user = create_local(session, email, "", Role.ADMIN, password)
    except (AccountError, PasswordError, ConflictError) as error:
        raise FirstRunError(f"{ADMIN_EMAIL_ENV}: {error}") from error
    detail = {"name": user.name, "role": Role.ADMIN.value, "source": "local", "first_admin": True, "via": ENVIRONMENT}
    session.add(AuditEvent(actor=user.subject, action="account.create", target=user.subject, detail=detail))
    return user.subject


def first_run(session: Session, config: AuthConfig, environ: Mapping[str, str]) -> FirstRun:
    if users_exist(session):
        clear_setup_token(session)
        return FirstRun()
    email = environ.get(ADMIN_EMAIL_ENV, "").strip()
    if email:
        return FirstRun(admin=admin_from_environment(session, email, environ))
    if sso_admin(session, config):
        clear_setup_token(session)
        return FirstRun()
    if setup_pending(session):
        return FirstRun(waiting=True)
    return FirstRun(token=issue_setup_token(session, SYSTEM_ACTOR))


def prepare(session: Session, config: AuthConfig, environ: Mapping[str, str]) -> FirstRun:
    found = first_run(session, config, environ)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        return FirstRun() if users_exist(session) else FirstRun(waiting=True)
    return found
