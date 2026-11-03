from sqlalchemy.orm import Session

from minibrain.connections.s3 import bucket_of
from minibrain.connections.spec import S3, ConnectionProblem
from minibrain.connections.store import check_policy, config_of, get_connection, list_connections
from minibrain.registry.models import Connection


def pick_connection(session: Session, location: str, connection_id: int | None) -> Connection | None:
    if not location.strip().startswith("s3://"):
        return None
    if connection_id is not None:
        chosen = get_connection(session, connection_id)
        if chosen.kind != S3:
            raise ConnectionProblem(f"{chosen.name} is not an S3 connection")
        return chosen
    bucket = bucket_of(location.strip())
    return next(
        (item for item in list_connections(session) if item.kind == S3 and config_of(item).bucket == bucket),
        None,
    )


def check_connection_policy(session: Session, connection_id: int) -> None:
    connection = get_connection(session, connection_id)
    check_policy(session, connection.name, config_of(connection))
