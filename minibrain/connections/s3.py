import json
import os
from collections.abc import Callable
from typing import Any
from urllib.parse import urlparse

from minibrain.connections.spec import ConnectionConfig, config_from
from minibrain.connections.store import Resolved

JOB_ENV = "MINIBRAIN_JOB_CONNECTION"


def bucket_of(url: str) -> str:
    return urlparse(url).netloc if url.startswith("s3://") else ""


def s3fs_for(config: ConnectionConfig, secret: str) -> Any:
    import s3fs

    return s3fs.S3FileSystem(
        key=config.access_key,
        secret=secret,
        endpoint_url=config.endpoint_url,
        skip_instance_cache=True,
        client_kwargs={"region_name": config.region or "us-east-1"},
        config_kwargs={
            "s3": {"addressing_style": "path" if config.path_style else "virtual"},
            "retries": {"max_attempts": 2, "mode": "standard"},
            "connect_timeout": 5,
            "read_timeout": 60,
        },
    )


FILESYSTEMS: dict[str, Callable[[ConnectionConfig, str], Any]] = {"s3": s3fs_for}


def filesystem(connection: Resolved) -> Any:
    return FILESYSTEMS["s3"](connection.config, connection.secret)


def job_env(connection: Resolved) -> dict[str, str]:
    payload = connection.config.as_dict() | {"name": connection.name, "secret": connection.secret}
    return {JOB_ENV: json.dumps(payload)}


def env_connection() -> tuple[ConnectionConfig, str] | None:
    raw = os.environ.get(JOB_ENV, "")
    if not raw:
        return None
    payload = json.loads(raw)
    return config_from(payload), str(payload.get("secret") or "")
