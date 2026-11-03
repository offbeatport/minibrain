from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from minibrain.connections.declared import SecretRef, declared, read_reference, ref_from
from minibrain.connections.spec import (
    KINDS,
    S3,
    SECRET_LABELS,
    ConnectionConfig,
    ConnectionProblem,
    clean,
    clean_name,
    config_from,
)
from minibrain.connections.vault import VaultError, seal, unseal
from minibrain.policy import LockedError, PolicyError
from minibrain.policy import load as load_policy
from minibrain.registry.models import AuditEvent, Connection, Model, now
from minibrain.registry.service import ConflictError, NotFoundError
from minibrain.settings import Settings

UI = "ui"
CONFIG = "config"
REMOVED = "no longer declared in minibrain.yaml"


@dataclass(frozen=True)
class Resolved:
    id: int
    name: str
    config: ConnectionConfig
    secret: str = field(repr=False)


def context(connection: Connection) -> str:
    return f"minibrain.connection.{connection.id}"


def config_of(connection: Connection) -> ConnectionConfig:
    return config_from((connection.config or {}) | {"kind": connection.kind})


def locked(connection: Connection) -> bool:
    return connection.origin == CONFIG


def reference(connection: Connection) -> SecretRef | None:
    return ref_from(connection.secret_ref)


def apply_declared(session: Session, row: Connection | None, item: Any) -> Connection:
    config = item.config.as_dict() if item.config is not None else {}
    kind = item.config.kind if item.config is not None else (item.kind if item.kind in KINDS else S3)
    values: dict[str, Any] = {
        "kind": kind,
        "config": config,
        "secret": None,
        "secret_ref": item.secret.as_dict() if item.secret is not None else None,
        "origin": CONFIG,
        "problem": item.problem,
    }
    if row is None:
        row = Connection(name=item.name, **values)
        session.add(row)
        return row
    if any(getattr(row, name) != value for name, value in values.items()) or row.name != item.name:
        row.name = item.name
        for name, value in values.items():
            setattr(row, name, value)
        row.updated_at = now()
    return row


def sync_declared(session: Session) -> None:
    rows = {row.name.lower(): row for row in session.scalars(select(Connection))}
    wanted = {item.name.lower(): item for item in declared()}
    for key, item in wanted.items():
        apply_declared(session, rows.get(key), item)
    for key, row in rows.items():
        if row.origin != CONFIG or key in wanted:
            continue
        if row.sources:
            if row.problem != REMOVED:
                row.problem = REMOVED
                row.updated_at = now()
        else:
            session.delete(row)
    session.flush()


def list_connections(session: Session) -> list[Connection]:
    sync_declared(session)
    return list(session.scalars(select(Connection).order_by(func.lower(Connection.name))))


def get_connection(session: Session, connection_id: int) -> Connection:
    found = session.get(Connection, connection_id)
    if found is None:
        raise NotFoundError(f"no connection {connection_id}")
    return found


def check_policy(session: Session, name: str, config: ConnectionConfig) -> None:
    try:
        load_policy(session).outbound(config.address)
    except PolicyError as error:
        raise PolicyError(
            f"{name}: {error}. Add the host under Settings, Security, Allowed hosts, or use another endpoint"
        ) from error


def blocked(session: Session, connection: Connection) -> str | None:
    if connection.problem:
        return connection.problem
    try:
        check_policy(session, connection.name, config_of(connection))
    except (PolicyError, ConnectionProblem) as error:
        return str(error)
    return None


def secret_of(settings: Settings, connection: Connection) -> str:
    ref = reference(connection)
    if ref is not None:
        return read_reference(ref)
    if not connection.secret:
        raise ConnectionProblem(f"{connection.name} has no {SECRET_LABELS[connection.kind]} saved yet")
    try:
        return unseal(settings, connection.secret, context(connection))
    except VaultError as error:
        raise ConnectionProblem(f"{connection.name}: {error}") from error


def secret_problem(settings: Settings, connection: Connection) -> str | None:
    try:
        secret_of(settings, connection)
    except ConnectionProblem as error:
        return str(error)
    return None


def resolve(session: Session, settings: Settings, connection: Connection) -> Resolved:
    if connection.problem:
        raise ConnectionProblem(f"{connection.name}: {connection.problem}")
    config = config_of(connection)
    check_policy(session, connection.name, config)
    return Resolved(id=connection.id, name=connection.name, config=config, secret=secret_of(settings, connection))


def draft(name: str, config: ConnectionConfig) -> tuple[str, ConnectionConfig]:
    return clean_name(name), clean(config)


def require_free_name(session: Session, name: str, keep: Connection | None = None) -> None:
    taken = session.scalar(select(Connection).where(func.lower(Connection.name) == name.lower()))
    if taken is not None and taken is not keep:
        raise ConflictError(f"a connection called {taken.name} already exists")


def audit(session: Session, actor: str, action: str, connection: Connection, **detail: Any) -> None:
    config = config_of(connection)
    session.add(
        AuditEvent(
            actor=actor,
            action=action,
            target=f"connection:{connection.id}",
            detail={"name": connection.name, "kind": connection.kind, "address": config.summary} | detail,
        )
    )


def create_connection(
    session: Session, settings: Settings, name: str, config: ConnectionConfig, secret: str | None, actor: str
) -> Connection:
    sync_declared(session)
    name, config = draft(name, config)
    require_free_name(session, name)
    check_policy(session, name, config)
    if not (secret or "").strip():
        raise ConnectionProblem(f"give the {SECRET_LABELS[config.kind]}")
    connection = Connection(name=name, kind=config.kind, config=config.as_dict(), origin=UI)
    session.add(connection)
    session.flush()
    connection.secret = seal(settings, (secret or "").strip(), context(connection))
    audit(session, actor, "connection.create", connection)
    return connection


def require_editable(connection: Connection) -> None:
    if locked(connection):
        raise LockedError(f"{connection.name} is set in minibrain.yaml and cannot be changed here")


def update_connection(
    session: Session,
    settings: Settings,
    connection: Connection,
    name: str,
    config: ConnectionConfig,
    secret: str | None,
    actor: str,
) -> Connection:
    require_editable(connection)
    name, config = draft(name, config)
    if config.kind != connection.kind and connection.sources:
        raise ConflictError(f"{connection.name} is used by sources, so its kind cannot change")
    require_free_name(session, name, connection)
    check_policy(session, name, config)
    before = config_of(connection).as_dict() | {"name": connection.name}
    after = config.as_dict() | {"name": name}
    changed = sorted(key for key in after if before.get(key) != after[key])
    connection.name = name
    connection.kind = config.kind
    connection.config = config.as_dict()
    replaced = bool((secret or "").strip())
    if replaced:
        connection.secret = seal(settings, (secret or "").strip(), context(connection))
    connection.updated_at = now()
    audit(session, actor, "connection.update", connection, changed=changed, secret="replaced" if replaced else "kept")
    return connection


def delete_connection(session: Session, connection: Connection, actor: str) -> None:
    require_editable(connection)
    if connection.sources:
        names = ", ".join(source.name for source in connection.sources)
        raise ConflictError(f"{connection.name} is used by {names}; delete those sources first")
    audit(session, actor, "connection.delete", connection)
    for model in session.scalars(select(Model).where(Model.connection_id == connection.id)):
        model.connection_id = None
    session.delete(connection)
