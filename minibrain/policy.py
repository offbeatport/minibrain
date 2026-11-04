import functools
import logging
import os
import re
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

import yaml
from sqlalchemy.orm import Session

from minibrain.models.rules import LICENCES, PUBLISHERS, licence_use
from minibrain.registry.models import AuditEvent
from minibrain.registry.settings_store import read, write

log = logging.getLogger("minibrain.policy")

PREFIX = "policy."
OTLP_HTTP = "http/protobuf"
HEADER_NAME = re.compile(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+")


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
        "request_bodies",
        "Request inputs and answers",
        "The default for new models: keep each request's input (the last user message) and the model's answer with "
        "its request log, for feedback by response ID, distillation and the Requests tab. Builders change it per model "
        "on its deployment page. Deleted with the request logs.",
        "bool",
        False,
    ),
    Field(
        "request_bodies_locked",
        "Lock for every model",
        "Every model, existing and new, follows Request inputs and answers above, and Builders cannot change it per "
        "model.",
        "bool",
        False,
    ),
    Field(
        "data_folders",
        "Folder sources",
        "Folders on this server that folder sources and Delta Lake tables may read, with everything under them. Leave "
        "empty to allow none.",
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
        "default_role",
        "Role for new people",
        "The role of people who sign in through single sign-on or a proxy without a group mapped in "
        "minibrain.yaml. With No role they see Ask an admin for access until an admin gives them one.",
        "choice",
        "none",
        ("none", "viewer", "builder", "admin"),
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
    Field(
        "otel_protocol",
        "OpenTelemetry export",
        "Send traces and metrics of /v1 requests, jobs and workers to your own OpenTelemetry collector over OTLP. They "
        "go there and nowhere else, whatever the network policy, and never carry prompts or answers. Off sends "
        "nothing.",
        "choice",
        "off",
        ("off", OTLP_HTTP),
    ),
    Field(
        "otel_endpoint",
        "Collector endpoint",
        "Base URL of the collector's OTLP/HTTP receiver, such as https://otel-collector.internal:4318. Traces go to "
        "/v1/traces under it and metrics to /v1/metrics.",
        "url",
        "",
    ),
    Field(
        "otel_headers",
        "Collector headers",
        "Headers sent with every export, as name=value pairs separated by commas, such as "
        "Authorization=Bearer <token>. The values are stored encrypted and never shown again; only the names are.",
        "headers",
        "",
    ),
    Field(
        "otel_service_name",
        "Service name",
        "The service.name on every span and metric, so the collector can tell installs apart.",
        "text",
        "minibrain",
    ),
    Field(
        "otel_ca_bundle",
        "Collector CA bundle",
        "PEM file on this server with the CA certificates that sign the collector's TLS certificate. Empty trusts the "
        "system's CAs.",
        "text",
        "",
    ),
    Field(
        "encryption",
        "Master key",
        "Where the master key lives that wraps each stored file's own data key. Files written before a change stay "
        "readable; Rotate master key re-wraps them under the new one. Off writes new files unencrypted.",
        "choice",
        "local",
        ("local", "vault", "hsm", "kms", "off"),
    ),
    Field(
        "vault_address",
        "Vault address",
        "Vault's URL, such as https://vault.internal:8200, for HashiCorp Vault Transit. minibrain calls it whatever "
        "the network policy says, as it does artifact storage.",
        "text",
        "",
    ),
    Field("vault_mount", "Transit mount", "Path the Transit secrets engine is mounted at.", "text", "transit"),
    Field(
        "vault_key",
        "Transit key",
        "Name of the aes256-gcm96 Transit key that wraps the data keys.",
        "text",
        "minibrain",
    ),
    Field("vault_namespace", "Vault namespace", "Vault Enterprise namespace. Empty for none.", "text", ""),
    Field(
        "vault_auth",
        "Vault sign-in",
        "Token reads MINIBRAIN_VAULT_TOKEN, or the file MINIBRAIN_VAULT_TOKEN_FILE names. AppRole signs in with the "
        "role ID below and the secret ID from MINIBRAIN_VAULT_SECRET_ID or MINIBRAIN_VAULT_SECRET_ID_FILE.",
        "choice",
        "token",
        ("token", "approle"),
    ),
    Field("vault_role_id", "AppRole role ID", "Not a secret: the secret ID stays in the environment.", "text", ""),
    Field("vault_auth_mount", "AppRole mount", "Path the AppRole auth method is mounted at.", "text", "approle"),
    Field(
        "vault_ca_bundle",
        "Vault CA bundle",
        "PEM file on this server with the CA certificates that sign Vault's TLS certificate. Empty trusts the "
        "system's CAs.",
        "text",
        "",
    ),
    Field(
        "hsm_library",
        "PKCS#11 library",
        "Path of the HSM vendor's PKCS#11 module on this server, such as /usr/lib/softhsm/libsofthsm2.so. The user "
        "PIN comes from MINIBRAIN_HSM_PIN or the file MINIBRAIN_HSM_PIN_FILE names.",
        "text",
        "",
    ),
    Field("hsm_token", "HSM token", "Label of the token (partition) that holds the key.", "text", ""),
    Field(
        "hsm_key",
        "HSM key label",
        "Label of the AES-256 keys that wrap the data keys; each version has its number as CKA_ID.",
        "text",
        "minibrain-master",
    ),
    Field(
        "kms_key",
        "AWS KMS key",
        "ARN of the symmetric KMS key (or an alias ARN) that wraps the data keys. Credentials come from the server's "
        "AWS environment: variables, profile, web identity or instance role.",
        "text",
        "",
    ),
    Field("kms_region", "AWS region", "Region of the key. Empty takes it from the key ARN.", "text", ""),
    Field(
        "kms_endpoint",
        "AWS KMS endpoint",
        "https:// URL of a VPC endpoint for KMS. Empty uses AWS's endpoint for the region.",
        "text",
        "",
    ),
    Field(
        "kms_fips",
        "FIPS endpoints",
        "Call KMS through its FIPS 140 validated endpoint (kms-fips.<region>.amazonaws.com).",
        "bool",
        False,
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
    OTLP_HTTP: "OTLP over HTTP (protobuf)",
    "none": "No role",
    "viewer": "Viewer",
    "builder": "Builder",
    "admin": "Admin",
    "local": "Local key file",
    "vault": "HashiCorp Vault Transit",
    "hsm": "PKCS#11 HSM",
    "kms": "AWS KMS",
    "token": "Token",
    "approle": "AppRole",
} | {key: value[0] for key, value in LICENCES.items()}

BY_NAME = {field.name: field for field in FIELDS}
ENV = {field.name: f"MINIBRAIN_POLICY_{field.name.upper()}" for field in FIELDS}
OTEL_ENV = {
    "otel_protocol": "OTEL_EXPORTER_OTLP_PROTOCOL",
    "otel_endpoint": "OTEL_EXPORTER_OTLP_ENDPOINT",
    "otel_headers": "OTEL_EXPORTER_OTLP_HEADERS",
    "otel_service_name": "OTEL_SERVICE_NAME",
    "otel_ca_bundle": "OTEL_EXPORTER_OTLP_CERTIFICATE",
}
OTEL_SIGNAL_ENDPOINTS = ("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT")
TRUE = {"1", "true", "yes", "on"}
RETIRED = {"request_logs": "request metadata is always logged; request_bodies sets whether inputs and answers are kept"}
Sealer = Callable[[str, str], str]


def config_path() -> Path:
    explicit = os.environ.get("MINIBRAIN_CONFIG")
    if explicit:
        return Path(explicit).expanduser()
    return Path(os.environ.get("MINIBRAIN_HOME", Path.home() / ".minibrain")).expanduser() / "minibrain.yaml"


def config_file() -> dict[str, Any]:
    path = config_path()
    if not path.is_file():
        return {}
    loaded = yaml.safe_load(path.read_text()) or {}
    return loaded if isinstance(loaded, dict) else {}


def config_section(name: str) -> dict[str, Any]:
    found = config_file().get(name)
    return found if isinstance(found, dict) else {}


def from_file() -> dict[str, Any]:
    return config_section("policy")


def header_pairs(text: str) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    for item in text.split(","):
        if not item.strip():
            continue
        name, equals, raw = item.partition("=")
        name, raw = name.strip(), raw.strip()
        if not equals or not HEADER_NAME.fullmatch(name) or not raw:
            raise PolicyError("Collector headers are name=value pairs separated by commas, such as X-Tenant=acme")
        found = unquote(raw)
        if any(character in found for character in "\r\n\0"):
            raise PolicyError(f"Collector header {name} cannot contain line breaks")
        pairs.append((name, found))
    return pairs


def header_names(value: Any) -> list[str]:
    return list(value.get("names", [])) if isinstance(value, dict) else []


def plain_url(field: Field, value: Any) -> str:
    text = str(value).strip().rstrip("/")
    if not text:
        return ""
    parsed = urlparse(text)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise PolicyError(f"{field.label} is an http:// or https:// URL, such as https://otel-collector.internal:4318")
    if parsed.username or parsed.password:
        raise PolicyError(f"{field.label} cannot carry a user name or password; send credentials as headers")
    if parsed.query or parsed.fragment:
        raise PolicyError(f"{field.label} takes no query string or fragment")
    try:
        port = parsed.port
    except ValueError:
        port = 0
    if port == 0:
        raise PolicyError(f"{field.label} has an invalid port")
    return text


def coerce(field: Field, value: Any) -> Any:
    if field.kind == "bool":
        if isinstance(value, str):
            return value.strip().lower() in TRUE
        return bool(value)
    if field.kind == "url":
        return plain_url(field, value)
    if field.kind == "headers":
        text = str(value or "").strip()
        return {"names": [name for name, _ in header_pairs(text)], "plain": text}
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


@functools.cache
def retired(name: str, source: str) -> None:
    log.warning("%s sets %s, which is no longer a policy: %s", source, name, RETIRED[name])


def implied_locks(found: dict[str, tuple[str, Any]]) -> dict[str, tuple[str, Any]]:
    if "request_bodies" in found and "request_bodies_locked" not in found:
        return {"request_bodies_locked": (found["request_bodies"][0], True)}
    return {}


def locked_sources() -> dict[str, tuple[str, Any]]:
    found: dict[str, tuple[str, Any]] = {}
    for name, value in from_file().items():
        if name in BY_NAME:
            found[name] = ("config file", coerce(BY_NAME[name], value))
        elif name in RETIRED:
            retired(name, "minibrain.yaml")
    auth = config_section("auth")
    if "default_role" in auth:
        found["default_role"] = ("config file", coerce(BY_NAME["default_role"], auth["default_role"]))
    found |= otel_environment(found)
    for name, variable in ENV.items():
        if os.environ.get(variable):
            found[name] = ("environment", coerce(BY_NAME[name], os.environ[variable]))
    for name in RETIRED:
        if os.environ.get(f"MINIBRAIN_POLICY_{name.upper()}"):
            retired(name, f"MINIBRAIN_POLICY_{name.upper()}")
    if os.environ.get("MINIBRAIN_OFFLINE", "").strip().lower() in {"1", "true", "yes"}:
        found["network"] = ("environment", "offline")
    return found | implied_locks(found)


@functools.cache
def unsupported_protocol(value: str) -> str:
    log.warning("OTEL_EXPORTER_OTLP_PROTOCOL is %s; minibrain exports only %s, so export stays off", value, OTLP_HTTP)
    return "off"


def otel_value(name: str, raw: str) -> Any:
    if name == "otel_protocol" and raw.strip().lower() not in BY_NAME[name].choices:
        return unsupported_protocol(raw.strip().lower())
    return coerce(BY_NAME[name], raw)


def otel_environment(locked: dict[str, tuple[str, Any]]) -> dict[str, tuple[str, Any]]:
    found: dict[str, tuple[str, Any]] = {}
    for name, variable in OTEL_ENV.items():
        if os.environ.get(variable, "").strip():
            found[name] = ("environment", otel_value(name, os.environ[variable]))
    aimed = "otel_endpoint" in found or any(os.environ.get(variable, "").strip() for variable in OTEL_SIGNAL_ENDPOINTS)
    if aimed and "otel_protocol" not in found and "otel_protocol" not in locked:
        found["otel_protocol"] = ("environment", OTLP_HTTP)
    if os.environ.get("OTEL_SDK_DISABLED", "").strip().lower() in TRUE:
        found["otel_protocol"] = ("environment", "off")
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

    def keeps_bodies(self, chosen: bool) -> bool:
        return bool(self["request_bodies"]) if self["request_bodies_locked"] else chosen


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


def bodies_choice(session: Session, chosen: bool) -> tuple[bool, str | None]:
    policy = load(session)
    if not policy["request_bodies_locked"]:
        return chosen, None
    source = locked_sources().get("request_bodies_locked", ("ui", True))[0]
    return bool(policy["request_bodies"]), source


def choice_of(field: Field, choice: str) -> dict[str, Any]:
    described: dict[str, Any] = {"value": choice, "label": CHOICE_LABELS.get(choice, choice)}
    if field.name == "licences":
        described["use"] = licence_use(choice)
    return described


def shown(field: Field, value: Any) -> Any:
    return header_names(value) if field.kind == "headers" else value


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
            "value": shown(field, policy[field.name]),
            "locked": field.name in locked or not field.editable,
            "source": locked[field.name][0] if field.name in locked else ("built in" if not field.editable else "ui"),
        }
        for field in FIELDS
    ]


def sealed(field: Field, value: dict[str, Any], seal: Sealer | None) -> dict[str, Any]:
    if not value["plain"]:
        return {"names": [], "sealed": ""}
    if seal is None:
        raise PolicyError(f"{field.label} can only be set where secrets can be encrypted")
    return {"names": value["names"], "sealed": seal(value["plain"], PREFIX + field.name)}


def update(session: Session, name: str, value: Any, actor: str, seal: Sealer | None = None) -> Any:
    field = BY_NAME.get(name)
    if field is None:
        raise PolicyError(f"No policy called {name}")
    if not field.editable or name in locked_sources():
        raise LockedError(f"{field.label} is set by configuration and cannot be changed here")
    before = shown(field, load(session)[name])
    after = coerce(field, value)
    if field.kind == "headers":
        after = sealed(field, after, seal)
    write(session, PREFIX + name, after)
    detail = {"from": before, "to": shown(field, after)}
    session.add(AuditEvent(actor=actor, action="policy.update", target=name, detail=detail))
    return after
