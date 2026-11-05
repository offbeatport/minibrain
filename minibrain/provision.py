import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated, Any, Literal
from urllib.parse import urlparse

import yaml
from pydantic import BaseModel, Field, StringConstraints, ValidationError

from minibrain.api.schemas import DataSettingsUpdate
from minibrain.policy import BY_NAME, RETIRED, LockedError, PolicyError, coerce, config_path

log = logging.getLogger("minibrain")

FILE = "config file"
ENVIRONMENT = "environment"
ENV_NAME = r"^[A-Za-z_][A-Za-z0-9_]*$"
PLAINTEXT = ("secret", "secret_key", "password", "passwd", "token")
SECTIONS = ("policy", "auth", "logging", "metrics", "storage", "data", "compute", "catalogue", "connections")
AUTH_KEYS = ("default_role", "roles", "admins", "proxy", "oidc")
LOCKED_BY = {FILE: "set in minibrain.yaml", ENVIRONMENT: "set by the server's environment"}
MAX_HOURLY_PRICE = 1_000_000

PoolName = Annotated[str, StringConstraints(min_length=1, max_length=200)]
HourlyPrice = Annotated[float, Field(ge=0, le=MAX_HOURLY_PRICE)]


class ConfigError(Exception):
    pass


class StorageSection(BaseModel):
    kind: Literal["local", "s3"] = "local"
    endpoint: str = Field(default="", max_length=2048)
    bucket: str = Field(default="", max_length=255)
    prefix: str = Field(default="minibrain", max_length=1024)
    region: str = Field(default="", max_length=64)
    access_key: str = Field(default="", max_length=256)
    secret_env: str | None = Field(default=None, pattern=ENV_NAME)
    secret_file: str | None = Field(default=None, min_length=1)


class ComputeSection(BaseModel):
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    prices: dict[PoolName, HourlyPrice] | None = None


class CatalogueSection(BaseModel):
    daily_sync: bool | None = None


MODELS: dict[str, type[BaseModel]] = {
    "storage": StorageSection,
    "data": DataSettingsUpdate,
    "compute": ComputeSection,
    "catalogue": CatalogueSection,
}
ENV_KEYS = {
    "storage": ("kind", "endpoint", "bucket", "prefix", "region", "access_key"),
    "data": ("row_limit", "keep_snapshots", "checks_off", "majority_share", "min_label_rows"),
    "compute": ("currency",),
    "catalogue": ("daily_sync",),
}
LISTS = {"checks_off"}


@dataclass(frozen=True)
class Provided:
    values: dict[str, Any] = field(default_factory=dict)
    sources: dict[str, str] = field(default_factory=dict)

    def __bool__(self) -> bool:
        return bool(self.sources)

    def source(self, key: str) -> str | None:
        return self.sources.get(key)

    def locked_by(self) -> str | None:
        return ENVIRONMENT if ENVIRONMENT in self.sources.values() else (FILE if self.sources else None)

    def refuse_all(self, label: str) -> None:
        found = self.locked_by()
        if found:
            raise LockedError(f"{label} is {LOCKED_BY[found]}, so it can only be changed there")

    def refuse(self, key: str, label: str) -> None:
        found = self.sources.get(key)
        if found:
            raise LockedError(f"{label} is {LOCKED_BY[found]}, so it can only be changed there")


def env_name(section: str, key: str) -> str:
    return f"MINIBRAIN_{section.upper()}_{key.upper()}"


def read_file() -> dict[str, Any]:
    path = config_path()
    if not path.is_file():
        return {}
    try:
        loaded = yaml.safe_load(path.read_text())
    except yaml.YAMLError as error:
        raise ConfigError(f"{path} is not valid YAML: {error}") from error
    if loaded is None:
        return {}
    if not isinstance(loaded, dict):
        raise ConfigError(f"{path} must be a mapping of sections such as policy: and storage:")
    return loaded


def raw_section(config: dict[str, Any], name: str) -> dict[str, Any]:
    found = config.get(name)
    if found is None:
        return {}
    if not isinstance(found, dict):
        raise ConfigError(f"{name} in minibrain.yaml must be a mapping of settings")
    return found


def refuse_plaintext(name: str, section: dict[str, Any]) -> None:
    for key in PLAINTEXT:
        if key in section:
            raise ConfigError(
                f"{name}.{key}: minibrain.yaml never holds secrets; put it in an environment variable or a file "
                f"and name it with {name}.secret_env or {name}.secret_file"
            )


def env_value(key: str, raw: str) -> Any:
    return [item.strip() for item in raw.split(",") if item.strip()] if key in LISTS else raw.strip()


def explained(name: str, sources: dict[str, str], error: ValidationError) -> str:
    parts = []
    for item in error.errors():
        key = str(item["loc"][0]) if item["loc"] else ""
        rest = ".".join(str(part) for part in item["loc"][1:])
        where = env_name(name, key) if sources.get(key) == ENVIRONMENT else f"{name}.{key}"
        parts.append(f"{where}{f'.{rest}' if rest else ''}: {item['msg']}")
    return "; ".join(parts)


def checked_storage(values: dict[str, Any]) -> None:
    endpoint = str(values.get("endpoint") or "")
    if endpoint and urlparse(endpoint).scheme not in ("http", "https"):
        raise ConfigError("storage.endpoint must start with https:// or http://")
    if values.get("secret_env") and values.get("secret_file"):
        raise ConfigError("storage: name the secret key with one of secret_env or secret_file, not both")
    if values.get("kind") == "s3":
        missing = [key for key in ("endpoint", "bucket", "access_key") if not values.get(key)]
        if missing:
            raise ConfigError(f"storage.kind is s3, so storage also needs {', '.join(missing)}")


def provided(name: str, config: dict[str, Any] | None = None) -> Provided:
    loaded = read_file() if config is None else config
    model = MODELS[name]
    section = raw_section(loaded, name)
    refuse_plaintext(name, section)
    known = {key: value for key, value in section.items() if key in model.model_fields}
    sources = dict.fromkeys(known, FILE)
    for key in ENV_KEYS[name]:
        raw = os.environ.get(env_name(name, key), "")
        if raw.strip():
            known[key] = env_value(key, raw)
            sources[key] = ENVIRONMENT
    try:
        parsed = model.model_validate(known)
    except ValidationError as error:
        raise ConfigError(explained(name, sources, error)) from error
    values = parsed.model_dump(include=set(known))
    if name == "storage" and sources:
        checked_storage(parsed.model_dump())
    return Provided(values=values, sources=sources)


def storage_secret_ref(found: Provided) -> tuple[str, str] | None:
    if found.values.get("secret_file"):
        return ("file", str(found.values["secret_file"]))
    if found.values.get("secret_env"):
        return ("env", str(found.values["secret_env"]))
    return None


def read_storage_secret(found: Provided) -> str | None:
    ref = storage_secret_ref(found)
    if ref is None:
        return None
    kind, where = ref
    if kind == "env":
        return os.environ.get(where, "").strip()
    path = Path(where).expanduser()
    try:
        return path.read_text().strip() if path.is_file() else ""
    except OSError:
        return ""


def unknown_keys(name: str, section: dict[str, Any], known: Any) -> list[str]:
    return [f"minibrain.yaml: unknown setting {name}.{key}, ignored" for key in section if key not in known]


def policy_problems(config: dict[str, Any]) -> list[str]:
    warnings = []
    for name, value in raw_section(config, "policy").items():
        if name in RETIRED:
            continue
        field_ = BY_NAME.get(name)
        if field_ is None:
            warnings.append(f"minibrain.yaml: unknown policy {name}, ignored")
            continue
        try:
            coerce(field_, value)
        except (PolicyError, TypeError, ValueError) as error:
            raise ConfigError(f"policy.{name}: {error}") from error
        if field_.kind == "headers" and value:
            warnings.append(
                f"minibrain.yaml: policy.{name} holds secrets in the file; move them to OTEL_EXPORTER_OTLP_HEADERS"
            )
    return warnings


def auth_problems(config: dict[str, Any]) -> list[str]:
    from minibrain.auth.config import AuthConfigError, load_auth

    section = raw_section(config, "auth")
    warnings = unknown_keys("auth", section, AUTH_KEYS)
    if "default_role" in section:
        try:
            coerce(BY_NAME["default_role"], section["default_role"])
        except PolicyError as error:
            raise ConfigError(f"auth.default_role: {error}") from error
    try:
        loaded = load_auth()
    except AuthConfigError as error:
        raise ConfigError(str(error)) from error
    if loaded.admins and not loaded.external:
        warnings.append(
            "minibrain.yaml: auth.admins applies to people who sign in with single sign-on or a proxy; "
            "add auth.oidc or auth.proxy, or create the first admin with the setup link"
        )
    oidc = section.get("oidc")
    if isinstance(oidc, dict) and oidc.get("client_secret"):
        warnings.append(
            "minibrain.yaml: auth.oidc.client_secret holds a secret in the file; move it to "
            "MINIBRAIN_OIDC_CLIENT_SECRET or a file named by auth.oidc.client_secret_file"
        )
    return warnings


def telemetry_problems() -> None:
    from minibrain.telemetry.logs import LogFormatError, log_format
    from minibrain.telemetry.prometheus import MetricsConfigError, load_metrics_access

    try:
        log_format()
        load_metrics_access()
    except (LogFormatError, MetricsConfigError) as error:
        raise ConfigError(str(error)) from error


def connection_problems() -> list[str]:
    from minibrain.connections.declared import declared

    return [f"minibrain.yaml: connection {item.name}: {item.problem}" for item in declared() if item.problem]


def problems() -> list[str]:
    config = read_file()
    warnings = [f"minibrain.yaml: unknown section {name}, ignored" for name in config if name not in SECTIONS]
    for name, model in MODELS.items():
        warnings += unknown_keys(name, raw_section(config, name), (*model.model_fields, *PLAINTEXT))
        provided(name, config)
    warnings += policy_problems(config)
    warnings += auth_problems(config)
    telemetry_problems()
    warnings += connection_problems()
    found = provided("storage", config)
    if found.values.get("kind") == "s3" and storage_secret_ref(found) and not read_storage_secret(found):
        kind, where = storage_secret_ref(found) or ("", "")
        label = f"the environment variable {where}" if kind == "env" else f"the file {where}"
        warnings.append(f"minibrain.yaml: storage secret key not found in {label}")
    return warnings


def check_config() -> list[str]:
    found = problems()
    for warning in found:
        log.warning(warning)
    return found
