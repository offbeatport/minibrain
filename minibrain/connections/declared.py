import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from minibrain.connections.spec import (
    KNOWN,
    SECRET_LABELS,
    ConnectionConfig,
    ConnectionProblem,
    clean,
    clean_name,
    config_from,
)
from minibrain.policy import config_path

SECTION = "connections"
PLAINTEXT = ("secret", "secret_key", "password", "passwd")


@dataclass(frozen=True)
class SecretRef:
    env: str | None = None
    file: str | None = None

    @property
    def label(self) -> str:
        return f"environment variable {self.env}" if self.env else f"file {self.file}"

    def as_dict(self) -> dict[str, str]:
        return {"env": self.env} if self.env else {"file": self.file or ""}


@dataclass(frozen=True)
class Declared:
    name: str
    kind: str
    config: ConnectionConfig | None = None
    secret: SecretRef | None = None
    problem: str | None = None


def ref_from(stored: Any) -> SecretRef | None:
    if not isinstance(stored, dict):
        return None
    env, file = stored.get("env"), stored.get("file")
    if env:
        return SecretRef(env=str(env))
    return SecretRef(file=str(file)) if file else None


def read_reference(ref: SecretRef) -> str:
    if ref.env:
        value = os.environ.get(ref.env, "")
        if not value.strip():
            raise ConnectionProblem(f"secret not found: the environment variable {ref.env} is not set")
        return value.strip()
    path = Path(ref.file or "").expanduser()
    if not path.is_file():
        raise ConnectionProblem(f"secret not found: {path} does not exist")
    try:
        value = path.read_text().strip()
    except OSError as error:
        raise ConnectionProblem(f"secret not found: {path} cannot be read ({error.strerror})") from error
    if not value:
        raise ConnectionProblem(f"secret not found: {path} is empty")
    return value


def parse_entry(entry: Any, index: int) -> Declared:
    if not isinstance(entry, dict) or not entry.get("name"):
        return Declared(name=f"Connection {index + 1}", kind="", problem="each entry needs a name")
    kind = str(entry.get("kind") or "")
    try:
        name = clean_name(str(entry["name"]))
    except ConnectionProblem as error:
        return Declared(name=str(entry["name"]), kind=kind, problem=str(error))
    plaintext = [key for key in PLAINTEXT if entry.get(key)]
    if plaintext:
        label = SECRET_LABELS.get(kind, "secret")
        problem = (
            f"minibrain.yaml gives the {label} in plain text ({', '.join(plaintext)}); "
            "put it in an environment variable or a file and name it with secret_env or secret_file"
        )
        return Declared(name=name, kind=kind, problem=problem)
    env, file = entry.get("secret_env"), entry.get("secret_file")
    if bool(env) == bool(file):
        problem = "name the secret with exactly one of secret_env or secret_file"
        return Declared(name=name, kind=kind, problem=problem)
    unknown = sorted(set(entry) - KNOWN - {"name", "secret_env", "secret_file"})
    if unknown:
        return Declared(name=name, kind=kind, problem=f"unknown settings: {', '.join(unknown)}")
    try:
        config = clean(config_from(entry))
    except ConnectionProblem as error:
        return Declared(name=name, kind=kind, problem=str(error))
    secret = SecretRef(env=str(env)) if env else SecretRef(file=str(file))
    return Declared(name=name, kind=kind, config=config, secret=secret)


def declared() -> list[Declared]:
    path = config_path()
    if not path.is_file():
        return []
    loaded = yaml.safe_load(path.read_text()) or {}
    entries = loaded.get(SECTION) if isinstance(loaded, dict) else None
    if not isinstance(entries, list):
        return []
    found: dict[str, Declared] = {}
    for index, entry in enumerate(entries):
        parsed = parse_entry(entry, index)
        found.setdefault(parsed.name.lower(), parsed)
    return list(found.values())
