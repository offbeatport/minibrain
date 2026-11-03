import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import yaml
from sqlalchemy.orm import Session

from minibrain.models.rules import LICENCES, PUBLISHERS, licence_use
from minibrain.registry.models import AuditEvent
from minibrain.registry.settings_store import read, write

PREFIX = "policy."


class PolicyError(Exception):
    pass


class LockedError(Exception):
    pass


@dataclass(frozen=True)
class Field:
    name: str
    label: str
    description: str
    kind: str
    default: Any
    choices: tuple[str, ...] = ()
    editable: bool = True
    maximum: int | None = None
    minimum: int = 0


FIELDS: tuple[Field, ...] = (
    Field(
        "network",
        "Network",
        "Offline blocks every outbound call. Allowlist only reaches the hosts listed below.",
        "choice",
        "open",
        ("open", "allowlist", "offline"),
    ),
    Field(
        "allowed_hosts",
        "Allowed hosts",
        "Hosts minibrain may reach when Network is Allowlist, such as your Hugging Face mirror or bucket.",
        "list",
        [],
    ),
    Field(
        "model_sources",
        "Model sources",
        "Approved publishers only, any model, or imported files only.",
        "choice",
        "approved",
        ("approved", "any", "imports"),
    ),
    Field(
        "licence_mode",
        "Allowed licences",
        "Downloads are refused for models under licences that are not allowed here.",
        "choice",
        "selected",
        ("selected", "all"),
    ),
    Field(
        "licences",
        "Selected licences",
        "Licences we have reviewed for commercial use. Non-commercial licences are not offered.",
        "list",
        sorted(LICENCES),
        tuple(sorted(LICENCES)),
    ),
    Field(
        "safetensors_only",
        "Safetensors weights only",
        "Pickle weights can run code when loaded, so minibrain never loads them.",
        "bool",
        True,
        editable=False,
    ),
    Field(
        "request_logs",
        "Request logs",
        "Record each API request: time, key, model, status, latency. Logs never leave this install.",
        "bool",
        True,
    ),
    Field(
        "request_bodies",
        "Request inputs and answers",
        "Also keep each request's input and the model's answer, so apps can send feedback with the response ID "
        "alone. Needs request logs; kept as long as they are.",
        "bool",
        False,
    ),
    Field(
        "data_folders",
        "Folder sources",
        "Folders on this server that folder sources may read, with everything under them. Leave empty to allow none.",
        "list",
        [],
    ),
    Field("log_retention_days", "Log retention (days)", "Request logs older than this are deleted.", "int", 30),
    Field(
        "key_expiry_days",
        "API key expiry (days)",
        "New API keys expire after this many days; existing keys keep theirs. 0 means never.",
        "int",
        0,
    ),
    Field(
        "audit_retention_days",
        "Audit log retention (days)",
        "Audit events older than this are deleted for good. 0 keeps every event.",
        "int",
        0,
    ),
    Field(
        "session_idle_minutes",
        "Sign-in idle timeout (minutes)",
        "People are signed out after this long without using minibrain. 0 keeps them signed in until the session "
        "lifetime ends.",
        "int",
        30,
    ),
    Field(
        "session_hours",
        "Session lifetime (hours)",
        "People sign in again after this long, however active they are.",
        "int",
        12,
        maximum=24 * 90,
        minimum=1,
    ),
    Field(
        "siem_protocol",
        "SIEM export",
        "Send every audit event, in order, to your SIEM as RFC 5424 syslog. TLS checks the SIEM's certificate; "
        "UDP can lose events without notice. Off sends nothing.",
        "choice",
        "off",
        ("off", "tls", "tcp", "udp"),
    ),
    Field(
        "siem_host",
        "SIEM host",
        "Name or address of the syslog receiver. Audit events go there and nowhere else.",
        "host",
        "",
    ),
    Field(
        "siem_port",
        "SIEM port",
        "0 uses the standard port: 6514 for TLS, 514 for TCP and UDP.",
        "int",
        0,
        maximum=65535,
    ),
    Field(
        "siem_ca_bundle",
        "SIEM CA bundle",
        "PEM file on this server with the CA certificates that sign the SIEM's TLS certificate. Empty trusts the "
        "system's CAs.",
        "text",
        "",
    ),
)

CHOICE_LABELS = {
    "open": "Open",
    "allowlist": "Allowlist",
    "offline": "Offline",
    "approved": "Approved publishers",
    "any": "Any model",
    "imports": "Imports only",
    "selected": "Only selected licences",
    "all": "Any licence",
    "off": "Off",
    "tls": "TLS",
    "tcp": "TCP",
    "udp": "UDP",
} | {key: value[0] for key, value in LICENCES.items()}

BY_NAME = {field.name: field for field in FIELDS}
ENV = {field.name: f"MINIBRAIN_POLICY_{field.name.upper()}" for field in FIELDS}


def config_path() -> Path:
    explicit = os.environ.get("MINIBRAIN_CONFIG")
    if explicit:
        return Path(explicit).expanduser()
    return Path(os.environ.get("MINIBRAIN_HOME", Path.home() / ".minibrain")).expanduser() / "minibrain.yaml"


def from_file() -> dict[str, Any]:
    path = config_path()
    if not path.is_file():
        return {}
    loaded = yaml.safe_load(path.read_text()) or {}
    section = loaded.get("policy") if isinstance(loaded, dict) else None
    return section if isinstance(section, dict) else {}


def coerce(field: Field, value: Any) -> Any:
    if field.kind == "bool":
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "on"}
        return bool(value)
    if field.kind == "int":
        number = int(value)
        if number < field.minimum:
            raise PolicyError(
                f"{field.label} cannot be less than {field.minimum}"
                if field.minimum
                else f"{field.label} cannot be negative"
            )
        if field.maximum is not None and number > field.maximum:
            raise PolicyError(f"{field.label} cannot be more than {field.maximum}")
        return number
    if field.kind == "host":
        host = str(value).strip()
        if any(character.isspace() or character in "/@" for character in host):
            raise PolicyError(f"{field.label} is a host name or address, without a scheme, path or spaces")
        if host.count(":") == 1:
            raise PolicyError(f"{field.label} takes the host alone; the port has its own setting")
        return host
    if field.kind == "text":
        return str(value).strip()
    if field.kind == "list":
        items = value.split(",") if isinstance(value, str) else list(value)
        cleaned = [str(item).strip() for item in items if str(item).strip()]
        unknown = [item for item in cleaned if field.choices and item not in field.choices]
        if unknown:
            raise PolicyError(f"{field.label}: unknown {', '.join(unknown)}")
        return cleaned
    choice = str(value).strip().lower()
    if choice not in field.choices:
        raise PolicyError(f"{field.label} must be one of {', '.join(field.choices)}")
    return choice


def locked_sources() -> dict[str, tuple[str, Any]]:
    found: dict[str, tuple[str, Any]] = {}
    for name, value in from_file().items():
        if name in BY_NAME:
            found[name] = ("config file", coerce(BY_NAME[name], value))
    for name, variable in ENV.items():
        if os.environ.get(variable):
            found[name] = ("environment", coerce(BY_NAME[name], os.environ[variable]))
    if os.environ.get("MINIBRAIN_OFFLINE", "").strip().lower() in {"1", "true", "yes"}:
        found["network"] = ("environment", "offline")
    return found


@dataclass(frozen=True)
class Policy:
    values: dict[str, Any]

    def __getitem__(self, name: str) -> Any:
        return self.values[name]

    def outbound(self, url: str) -> None:
        host = (urlparse(url).hostname or "").lower()
        if self["network"] == "offline":
            raise PolicyError(f"Network policy is Offline: minibrain does not contact {host or url}")
        if self["network"] == "allowlist" and host not in {item.lower() for item in self["allowed_hosts"]}:
            raise PolicyError(f"Network policy is Allowlist and {host} is not on it")

    def outbound_allowed(self, url: str) -> bool:
        try:
            self.outbound(url)
        except PolicyError:
            return False
        return True

    def download(self, repo: str, licence: str, origin: str) -> None:
        sources = self["model_sources"]
        if sources == "imports":
            raise PolicyError("Model sources policy is Imports only: download the files elsewhere and import them")
        if sources == "approved" and (origin != "catalogue" or repo.split("/", 1)[0] not in PUBLISHERS):
            raise PolicyError("Model sources policy allows approved publishers only")
        if self["licence_mode"] == "all" or licence in self["licences"]:
            return
        if licence in LICENCES:
            raise PolicyError(f"Licence {licence} is not on the allowed list")
        raise PolicyError(f"Licence {licence} has not been reviewed; an admin can allow any licence")

    def add_from_hub(self) -> None:
        if self["model_sources"] != "any":
            raise PolicyError("Model sources policy does not allow adding models from Hugging Face")


def value(session: Session, name: str) -> Any:
    locked = locked_sources()
    if name in locked:
        return locked[name][1]
    return read(session, PREFIX + name, BY_NAME[name].default)


def load(session: Session) -> Policy:
    values = {field.name: read(session, PREFIX + field.name, field.default) for field in FIELDS}
    for name, (_, value) in locked_sources().items():
        values[name] = value
    values["safetensors_only"] = True
    return Policy(values)


def choice_of(field: Field, choice: str) -> dict[str, Any]:
    described: dict[str, Any] = {"value": choice, "label": CHOICE_LABELS.get(choice, choice)}
    if field.name == "licences":
        described["use"] = licence_use(choice)
    return described


def describe(session: Session) -> list[dict[str, Any]]:
    locked = locked_sources()
    policy = load(session)
    return [
        {
            "name": field.name,
            "label": field.label,
            "description": field.description,
            "kind": field.kind,
            "choices": [choice_of(field, choice) for choice in field.choices],
            "maximum": field.maximum,
            "value": policy[field.name],
            "locked": field.name in locked or not field.editable,
            "source": locked[field.name][0] if field.name in locked else ("built in" if not field.editable else "ui"),
        }
        for field in FIELDS
    ]


def update(session: Session, name: str, value: Any, actor: str) -> Any:
    field = BY_NAME.get(name)
    if field is None:
        raise PolicyError(f"No policy called {name}")
    if not field.editable or name in locked_sources():
        raise LockedError(f"{field.label} is set by configuration and cannot be changed here")
    before = load(session)[name]
    after = coerce(field, value)
    write(session, PREFIX + name, after)
    session.add(AuditEvent(actor=actor, action="policy.update", target=name, detail={"from": before, "to": after}))
    return after
