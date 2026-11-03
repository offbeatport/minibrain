import re
from dataclasses import asdict, dataclass, fields, replace
from typing import Any
from urllib.parse import urlparse

S3 = "s3"
POSTGRES = "postgres"
MYSQL = "mysql"
KINDS = (S3, POSTGRES, MYSQL)
DATABASES = (POSTGRES, MYSQL)
KIND_LABELS = {S3: "S3-compatible", POSTGRES: "PostgreSQL", MYSQL: "MySQL"}
SECRET_LABELS = {S3: "secret key", POSTGRES: "password", MYSQL: "password"}
DEFAULT_PORTS = {POSTGRES: 5432, MYSQL: 3306}
SSL_MODES = {
    POSTGRES: ("disable", "allow", "prefer", "require", "verify-ca", "verify-full"),
    MYSQL: ("disabled", "preferred", "required", "verify_ca", "verify_identity"),
}
DEFAULT_SSL = {POSTGRES: "prefer", MYSQL: "preferred"}
AWS_ENDPOINT = "https://s3.amazonaws.com"
NAME_LENGTH = 80
BUCKET = re.compile(r"^[a-z0-9][a-z0-9.\-_]{1,254}$")
HOST = re.compile(r"^(?:[A-Za-z0-9_][A-Za-z0-9.\-_]*|\[[0-9A-Fa-f:.]+\])$")


class ConnectionProblem(Exception):
    pass


@dataclass(frozen=True)
class ConnectionConfig:
    kind: str
    endpoint: str = ""
    region: str = ""
    bucket: str = ""
    access_key: str = ""
    path_style: bool = True
    host: str = ""
    port: int | None = None
    database: str = ""
    user: str = ""
    ssl_mode: str = ""

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)

    @property
    def endpoint_url(self) -> str:
        return self.endpoint or AWS_ENDPOINT

    @property
    def address(self) -> str:
        if self.kind == S3:
            return self.endpoint_url
        return f"{self.kind}://{self.host}:{self.port or DEFAULT_PORTS[self.kind]}"

    @property
    def summary(self) -> str:
        if self.kind == S3:
            where = f"s3://{self.bucket} at " if self.bucket else ""
            return f"{where}{self.endpoint_url}"
        return f"{self.user}@{self.host}:{self.port or DEFAULT_PORTS[self.kind]}/{self.database}"


KNOWN = {field.name for field in fields(ConnectionConfig)}


def config_from(values: dict[str, Any]) -> ConnectionConfig:
    known = {name: values[name] for name in KNOWN if name in values and values[name] is not None}
    port = known.get("port")
    if port not in (None, ""):
        try:
            known["port"] = int(port)
        except (TypeError, ValueError) as error:
            raise ConnectionProblem("the port must be a number") from error
    else:
        known.pop("port", None)
    if "path_style" in known:
        known["path_style"] = known["path_style"] in (True, "true", "yes", "on", "1", 1)
    text = {name: str(value).strip() for name, value in known.items() if name not in ("port", "path_style")}
    return replace(ConnectionConfig(kind=str(values.get("kind") or "")), **(known | text))


def clean_s3(config: ConnectionConfig) -> ConnectionConfig:
    endpoint = config.endpoint.rstrip("/")
    if endpoint and urlparse(endpoint).scheme not in ("http", "https"):
        raise ConnectionProblem("the endpoint must start with https:// or http://")
    if endpoint and not urlparse(endpoint).hostname:
        raise ConnectionProblem("the endpoint needs a host name")
    bucket = config.bucket.removeprefix("s3://").strip("/")
    if bucket and not BUCKET.match(bucket):
        raise ConnectionProblem(f"{bucket} is not a bucket name")
    if not config.access_key:
        raise ConnectionProblem("an S3 connection needs an access key")
    return replace(config, endpoint=endpoint, bucket=bucket, host="", port=None, database="", user="", ssl_mode="")


def clean_database(config: ConnectionConfig) -> ConnectionConfig:
    needed = (("host", config.host), ("database", config.database), ("user", config.user))
    missing = [label for label, value in needed if not value]
    if missing:
        raise ConnectionProblem(f"a {KIND_LABELS[config.kind]} connection needs {', '.join(missing)}")
    if not HOST.match(config.host):
        raise ConnectionProblem("give the host name or address only; the port has its own field")
    port = config.port or DEFAULT_PORTS[config.kind]
    if not 0 < port < 65536:
        raise ConnectionProblem("the port must be between 1 and 65535")
    ssl_mode = config.ssl_mode or DEFAULT_SSL[config.kind]
    if ssl_mode not in SSL_MODES[config.kind]:
        raise ConnectionProblem(f"SSL mode must be one of {', '.join(SSL_MODES[config.kind])}")
    return replace(
        config,
        port=port,
        ssl_mode=ssl_mode,
        endpoint="",
        region="",
        bucket="",
        access_key="",
        path_style=True,
    )


def clean(config: ConnectionConfig) -> ConnectionConfig:
    if config.kind not in KINDS:
        raise ConnectionProblem(f"a connection is one of {', '.join(KIND_LABELS.values())}")
    return clean_s3(config) if config.kind == S3 else clean_database(config)


def clean_name(name: str) -> str:
    cleaned = " ".join(name.split())
    if not cleaned:
        raise ConnectionProblem("give the connection a name")
    if len(cleaned) > NAME_LENGTH:
        raise ConnectionProblem(f"keep the name under {NAME_LENGTH} characters")
    return cleaned
