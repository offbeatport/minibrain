import os
import secrets
from collections.abc import Callable, Iterator
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any, BinaryIO
from urllib.parse import urlparse

from sqlalchemy.orm import Session

from minibrain.artifacts import ArtifactStore, is_artifact_id
from minibrain.encryption.envelope import HEADER
from minibrain.registry.models import AuditEvent
from minibrain.registry.settings_store import read, write
from minibrain.settings import Settings

KEY = "storage"
CREDENTIAL_FILE = "storage_s3_secret"
CREDENTIAL_ENV = "MINIBRAIN_STORAGE_S3_SECRET"
LOCAL = "local"
S3 = "s3"


class StorageError(Exception):
    pass


@dataclass(frozen=True)
class StorageConfig:
    kind: str = LOCAL
    endpoint: str = ""
    bucket: str = ""
    prefix: str = "minibrain"
    region: str = ""
    access_key: str = ""


def load_config(session: Session) -> StorageConfig:
    stored = read(session, KEY, {}) or {}
    known = {name: str(stored[name]) for name in asdict(StorageConfig()) if name in stored}
    return replace(StorageConfig(), **known)


def secret_path(settings: Settings) -> Path:
    return settings.home / "secrets" / CREDENTIAL_FILE


def read_secret(settings: Settings) -> str:
    override = os.environ.get(CREDENTIAL_ENV, "").strip()
    if override:
        return override
    path = secret_path(settings)
    return path.read_text().strip() if path.is_file() else ""


def write_secret(settings: Settings, value: str) -> None:
    path = secret_path(settings)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.touch(mode=0o600, exist_ok=True)
    path.chmod(0o600)
    path.write_text(value)


def clean(config: StorageConfig) -> StorageConfig:
    endpoint = config.endpoint.strip().rstrip("/")
    if endpoint and urlparse(endpoint).scheme not in ("http", "https"):
        raise StorageError("the endpoint must start with https:// or http://")
    return replace(
        config,
        endpoint=endpoint,
        bucket=config.bucket.strip(),
        prefix=config.prefix.strip().strip("/"),
        region=config.region.strip(),
        access_key=config.access_key.strip(),
    )


def require_complete(config: StorageConfig, secret: str) -> None:
    missing = [
        label
        for label, value in (
            ("endpoint", config.endpoint),
            ("bucket", config.bucket),
            ("access key", config.access_key),
            ("secret key", secret),
        )
        if not value
    ]
    if missing:
        raise StorageError(f"S3 storage needs {', '.join(missing)}")


def addressing(endpoint: str) -> str:
    return "virtual" if (urlparse(endpoint).hostname or "").endswith("amazonaws.com") else "path"


def s3_filesystem(config: StorageConfig, secret: str) -> Any:
    import s3fs

    return s3fs.S3FileSystem(
        key=config.access_key,
        secret=secret,
        endpoint_url=config.endpoint,
        skip_instance_cache=True,
        client_kwargs={"region_name": config.region or "us-east-1"},
        config_kwargs={
            "s3": {"addressing_style": addressing(config.endpoint)},
            "retries": {"max_attempts": 2, "mode": "standard"},
            "connect_timeout": 5,
            "read_timeout": 60,
        },
    )


FILESYSTEMS: dict[str, Callable[[StorageConfig, str], Any]] = {S3: s3_filesystem}


class BucketBlobs:
    def __init__(self, filesystem: Any, config: StorageConfig) -> None:
        self.fs = filesystem
        self.root = "/".join(part for part in (config.bucket, config.prefix, "artifacts") if part)
        self.location = f"s3://{self.root} at {config.endpoint}"

    def key(self, artifact_id: str) -> str:
        if not is_artifact_id(artifact_id):
            raise StorageError(f"not an artifact id: {artifact_id}")
        return f"{self.root}/{artifact_id[:2]}/{artifact_id}"

    def describe(self) -> str:
        return self.location

    def has(self, artifact_id: str) -> bool:
        return bool(self.fs.exists(self.key(artifact_id)))

    def upload(self, source: Path, artifact_id: str) -> None:
        self.fs.put_file(str(source), self.key(artifact_id))

    def download(self, artifact_id: str, target: Path) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        self.fs.get_file(self.key(artifact_id), str(target))

    def open(self, artifact_id: str) -> BinaryIO:
        return self.fs.open(self.key(artifact_id), "rb")

    def delete(self, artifact_id: str) -> None:
        key = self.key(artifact_id)
        if self.fs.exists(key):
            self.fs.rm_file(key)

    def ids(self) -> Iterator[str]:
        for path in sorted(self.fs.find(self.root)):
            name = str(path).rsplit("/", 1)[-1]
            if is_artifact_id(name) and str(path).rstrip("/").endswith(f"{name[:2]}/{name}"):
                yield name

    def head(self, artifact_id: str) -> bytes:
        return bytes(self.fs.cat_file(self.key(artifact_id), start=0, end=HEADER))


def bucket_for(config: StorageConfig, secret: str) -> BucketBlobs | None:
    if not config.endpoint or not config.bucket or not config.access_key or not secret:
        return None
    return BucketBlobs(FILESYSTEMS[S3](config, secret), config)


def apply(store: ArtifactStore, session: Session, settings: Settings) -> None:
    config = load_config(session)
    store.use(bucket_for(config, read_secret(settings)), writes=config.kind == S3)


def check(config: StorageConfig, secret: str) -> None:
    require_complete(config, secret)
    blobs = bucket_for(config, secret)
    if blobs is None:
        raise StorageError("S3 storage is not fully set up")
    probe = f"{blobs.root}/.minibrain-check-{secrets.token_hex(8)}"
    payload = secrets.token_bytes(32)
    try:
        with blobs.fs.open(probe, "wb") as stream:
            stream.write(payload)
        with blobs.fs.open(probe, "rb") as stream:
            echoed = stream.read()
        blobs.fs.rm_file(probe)
    except Exception as error:
        raise StorageError(f"could not write to {blobs.describe()}: {type(error).__name__}: {error}") from error
    if echoed != payload:
        raise StorageError(f"{blobs.describe()} returned different bytes than were written")


def save(session: Session, settings: Settings, update: StorageConfig, secret: str | None, actor: str) -> StorageConfig:
    config = clean(update)
    if config.kind not in (LOCAL, S3):
        raise StorageError("storage is either a local folder or S3-compatible")
    if config.kind == S3:
        check(config, secret or read_secret(settings))
    if secret:
        write_secret(settings, secret)
    before = load_config(session)
    write(session, KEY, asdict(config))
    session.add(
        AuditEvent(
            actor=actor,
            action="storage.update",
            target=KEY,
            detail={"from": before.kind, "to": config.kind, "endpoint": config.endpoint, "bucket": config.bucket},
        )
    )
    return config
