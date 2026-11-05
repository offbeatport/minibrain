import os
import re
from dataclasses import asdict
from typing import Any

import yaml
from sqlalchemy.orm import Session

from minibrain import policy, provision
from minibrain.connections.spec import S3
from minibrain.connections.store import config_of, list_connections, reference
from minibrain.data.limits import load_limits
from minibrain.models.catalog import daily_sync
from minibrain.object_store import CREDENTIAL_ENV, load_config, secret_path
from minibrain.registry.models import Connection
from minibrain.registry.prices import load_prices
from minibrain.settings import Settings
from minibrain.telemetry.logs import log_format
from minibrain.telemetry.prometheus import ADDRESSES_ENV, SCRAPE_CREDENTIAL_ENV

HEADER = (
    "minibrain.yaml exported by minibrain config export. Every setting here is locked in the UI.",
    "Secrets are never written here; provide them on the server as noted below.",
)
OIDC_CREDENTIAL_ENV = "MINIBRAIN_OIDC_CLIENT_SECRET"


def exported_policies(session: Session, notes: list[str]) -> dict[str, Any]:
    loaded = policy.load(session)
    found: dict[str, Any] = {}
    for field in policy.FIELDS:
        if not field.editable:
            continue
        if field.kind == "headers":
            if loaded[field.name]:
                notes.append(f"policy.{field.name}: set OTEL_EXPORTER_OTLP_HEADERS to the collector headers")
            continue
        value = loaded[field.name]
        found[field.name] = list(value) if isinstance(value, list | tuple) else value
    return found


def exported_auth(notes: list[str]) -> dict[str, Any]:
    section = {key: value for key, value in provision.raw_section(provision.read_file(), "auth").items()}
    section.pop("default_role", None)
    oidc = section.get("oidc")
    if isinstance(oidc, dict):
        oidc = dict(oidc)
        if oidc.pop("client_secret", None) or os.environ.get(OIDC_CREDENTIAL_ENV, "").strip():
            notes.append(f"auth.oidc: set {OIDC_CREDENTIAL_ENV}, or name a file in auth.oidc.client_secret_file")
        section["oidc"] = oidc
    return section


def exported_metrics(notes: list[str]) -> dict[str, Any]:
    section = dict(provision.raw_section(provision.read_file(), "metrics"))
    addresses = os.environ.get(ADDRESSES_ENV, "").strip()
    if addresses:
        section["addresses"] = [item.strip() for item in addresses.split(",") if item.strip()]
    if os.environ.get(SCRAPE_CREDENTIAL_ENV, "").strip():
        notes.append(f"metrics: set {SCRAPE_CREDENTIAL_ENV}, or name a file in metrics.token_file")
    return section


def exported_storage(session: Session, settings: Settings, notes: list[str]) -> dict[str, Any]:
    config = load_config(session)
    if config.kind != "s3":
        return {"kind": config.kind}
    found: dict[str, Any] = {key: value for key, value in asdict(config).items() if value}
    named = provision.storage_secret_ref(provision.provided("storage"))
    if named is not None:
        kind, where = named
        found["secret_env" if kind == "env" else "secret_file"] = where
    elif os.environ.get(CREDENTIAL_ENV, "").strip():
        notes.append(f"storage: keep {CREDENTIAL_ENV} set to the secret key")
    elif secret_path(settings).is_file():
        found["secret_file"] = str(secret_path(settings))
        notes.append(f"storage: copy {secret_path(settings)} with the secret key, or change storage.secret_file")
    return found


def exported_compute(session: Session) -> dict[str, Any]:
    prices = load_prices(session)
    found: dict[str, Any] = {"currency": prices.currency}
    if prices.hourly:
        found["prices"] = dict(sorted(prices.hourly.items()))
    return found


def secret_variable(name: str) -> str:
    return "MINIBRAIN_CONNECTION_" + re.sub(r"[^A-Z0-9]+", "_", name.upper()).strip("_")


def exported_connection(connection: Connection, notes: list[str]) -> dict[str, Any]:
    config = config_of(connection).as_dict()
    entry: dict[str, Any] = {"name": connection.name, "kind": connection.kind}
    for key, value in config.items():
        if key == "kind" or value in ("", None) or (key == "path_style" and connection.kind != S3):
            continue
        entry[key] = value
    ref = reference(connection)
    if ref is not None and ref.env:
        entry["secret_env"] = ref.env
    elif ref is not None and ref.file:
        entry["secret_file"] = ref.file
    else:
        entry["secret_env"] = secret_variable(connection.name)
        notes.append(f"connection {connection.name}: set {entry['secret_env']} to its secret")
    return entry


def export(session: Session, settings: Settings) -> tuple[dict[str, Any], list[str]]:
    notes: list[str] = []
    limits = load_limits(session)
    found: dict[str, Any] = {
        "policy": exported_policies(session, notes),
        "auth": exported_auth(notes),
        "logging": {"format": log_format()},
        "metrics": exported_metrics(notes),
        "storage": exported_storage(session, settings, notes),
        "data": asdict(limits) | {"checks_off": list(limits.checks_off)},
        "compute": exported_compute(session),
        "catalogue": {"daily_sync": daily_sync(session)},
        "connections": [exported_connection(item, notes) for item in list_connections(session)],
    }
    return {key: value for key, value in found.items() if value or key in ("policy", "data")}, notes


def render(found: dict[str, Any], notes: list[str]) -> str:
    lines = [f"# {line}" for line in HEADER]
    lines += [f"#   {note}" for note in notes] or ["#   (none)"]
    body = yaml.safe_dump(found, sort_keys=False, default_flow_style=False, allow_unicode=True)
    return "\n".join(lines) + "\n" + body
