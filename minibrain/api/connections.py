from typing import cast

from fastapi import APIRouter
from sqlalchemy.orm import Session

from minibrain.api.data import source_summary
from minibrain.api.deps import SessionDep, SettingsDep, StoreDep
from minibrain.api.policies import LOCAL_USER
from minibrain.api.schemas import (
    ConnectionBody,
    ConnectionCheck,
    ConnectionInfo,
    ConnectionKind,
    ConnectionSourceRef,
    ConnectionTables,
    ConnectionTestBody,
    DatabaseSourceCreate,
    ExtensionInfo,
    ExtensionsInfo,
    IcebergSourceCreate,
    S3SourceCreate,
    SourceSummary,
)
from minibrain.artifacts import ArtifactStore
from minibrain.connections.spec import ConnectionConfig, ConnectionProblem, clean, clean_name, config_from
from minibrain.connections.store import (
    Resolved,
    blocked,
    check_policy,
    config_of,
    create_connection,
    delete_connection,
    get_connection,
    list_connections,
    locked,
    reference,
    resolve,
    secret_of,
    secret_problem,
    update_connection,
)
from minibrain.data import extensions
from minibrain.data.remote import DATABASE, ICEBERG, S3_SOURCE, database_tables, probe
from minibrain.data.shared import add_remote, get_source
from minibrain.data.sources import SourceError
from minibrain.policy import PolicyError
from minibrain.registry.models import Connection
from minibrain.settings import Settings

router = APIRouter(prefix="/api", tags=["connections"])


def body_config(body: ConnectionBody) -> ConnectionConfig:
    return config_from(body.model_dump(exclude={"name", "secret", "id"}))


def connection_info(session: Session, settings: Settings, connection: Connection) -> ConnectionInfo:
    config = config_of(connection)
    ref = reference(connection)
    missing = secret_problem(settings, connection)
    return ConnectionInfo(
        id=connection.id,
        name=connection.name,
        kind=cast(ConnectionKind, config.kind),
        endpoint=config.endpoint,
        region=config.region,
        bucket=config.bucket,
        access_key=config.access_key,
        path_style=config.path_style,
        host=config.host,
        port=config.port,
        database=config.database,
        user=config.user,
        ssl_mode=config.ssl_mode,
        summary=config.summary,
        secret_set=missing is None,
        secret_source=ref.label if ref is not None else None,
        locked=locked(connection),
        problem=blocked(session, connection) or missing,
        sources=[ConnectionSourceRef(id=source.id, name=source.name) for source in connection.sources],
        created_at=connection.created_at,
        updated_at=connection.updated_at,
    )


@router.get("/connections")
def read_connections(session: SessionDep, settings: SettingsDep) -> list[ConnectionInfo]:
    found = list_connections(session)
    session.commit()
    return [connection_info(session, settings, connection) for connection in found]


@router.post("/connections", status_code=201)
def add_connection(body: ConnectionBody, session: SessionDep, settings: SettingsDep) -> ConnectionInfo:
    connection = create_connection(session, settings, body.name, body_config(body), body.secret, LOCAL_USER)
    session.commit()
    return connection_info(session, settings, connection)


@router.put("/connections/{connection_id}")
def change_connection(
    connection_id: int, body: ConnectionBody, session: SessionDep, settings: SettingsDep
) -> ConnectionInfo:
    connection = get_connection(session, connection_id)
    update_connection(session, settings, connection, body.name, body_config(body), body.secret, LOCAL_USER)
    session.commit()
    return connection_info(session, settings, connection)


@router.delete("/connections/{connection_id}", status_code=204)
def remove_connection(connection_id: int, session: SessionDep) -> None:
    delete_connection(session, get_connection(session, connection_id), LOCAL_USER)
    session.commit()


def draft_resolved(session: Session, settings: Settings, body: ConnectionTestBody) -> Resolved:
    name, config = clean_name(body.name), clean(body_config(body))
    check_policy(session, name, config)
    secret = (body.secret or "").strip()
    if not secret and body.id is not None:
        secret = secret_of(settings, get_connection(session, body.id))
    if not secret:
        raise ConnectionProblem("give the secret to test with")
    return Resolved(id=body.id or 0, name=name, config=config, secret=secret)


@router.post("/connections/test")
def test_connection(body: ConnectionTestBody, session: SessionDep, settings: SettingsDep) -> ConnectionCheck:
    try:
        return ConnectionCheck(ok=True, message=probe(draft_resolved(session, settings, body)))
    except (SourceError, ConnectionProblem, PolicyError) as error:
        return ConnectionCheck(ok=False, message=str(error))


@router.post("/connections/{connection_id}/test")
def test_saved_connection(connection_id: int, session: SessionDep, settings: SettingsDep) -> ConnectionCheck:
    try:
        return ConnectionCheck(
            ok=True, message=probe(resolve(session, settings, get_connection(session, connection_id)))
        )
    except (SourceError, ConnectionProblem, PolicyError) as error:
        return ConnectionCheck(ok=False, message=str(error))


@router.get("/connections/{connection_id}/tables")
def connection_tables(connection_id: int, session: SessionDep, settings: SettingsDep) -> ConnectionTables:
    connection = resolve(session, settings, get_connection(session, connection_id))
    if connection.config.kind not in ("postgres", "mysql"):
        raise ConnectionProblem(f"{connection.name} is not a database connection")
    return ConnectionTables(tables=database_tables(connection))


@router.get("/extensions")
def read_extensions() -> ExtensionsInfo:
    return ExtensionsInfo(
        version=extensions.engine_version(),
        platform=extensions.platform(),
        directory=str(extensions.directory()),
        repository=extensions.repository(),
        command=extensions.INSTALL_HINT,
        extensions=[
            ExtensionInfo(name=state.name, purpose=state.purpose, installed=state.installed)
            for state in extensions.status()
        ],
    )


def added(session: Session, settings: Settings, store: ArtifactStore, source_id: int) -> SourceSummary:
    session.commit()
    return source_summary(settings, store, get_source(session, source_id))


@router.post("/sources/s3", status_code=201)
def add_s3_source(body: S3SourceCreate, session: SessionDep, settings: SettingsDep, store: StoreDep) -> SourceSummary:
    source = add_remote(session, settings, S3_SOURCE, body.connection_id, body.name, path=body.path, format=body.format)
    return added(session, settings, store, source.id)


@router.post("/sources/database", status_code=201)
def add_database_source(
    body: DatabaseSourceCreate, session: SessionDep, settings: SettingsDep, store: StoreDep
) -> SourceSummary:
    source = add_remote(
        session,
        settings,
        DATABASE,
        body.connection_id,
        body.name,
        path=body.table,
        query=body.query,
        change_column=body.change_column,
    )
    return added(session, settings, store, source.id)


@router.post("/sources/iceberg", status_code=201)
def add_iceberg_source(
    body: IcebergSourceCreate, session: SessionDep, settings: SettingsDep, store: StoreDep
) -> SourceSummary:
    source = add_remote(session, settings, ICEBERG, body.connection_id, body.name, path=body.path)
    return added(session, settings, store, source.id)
