import logging
import os
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from sqlalchemy import create_engine, inspect
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool

from minibrain.encryption.envelope import Wrapped, new_key
from minibrain.encryption.hsm import HSM, hsm_provider
from minibrain.encryption.kms import KMS, kms_provider
from minibrain.encryption.providers import LOCAL, KeyFile, KeyProvider, KeyUnavailableError, LocalKeys
from minibrain.encryption.vault_transit import VAULT, vault_provider
from minibrain.policy import load as load_policy
from minibrain.policy import locked_sources
from minibrain.registry.models import AuditEvent, now
from minibrain.registry.settings_store import read, write
from minibrain.settings import Settings

KEY_ENV = "MINIBRAIN_MASTER_KEY_FILE"
KEY_DIR = "keys"
KEY_FILE = "master.key"
OFF = "off"
POLICY = "encryption"
RECORDS = "encryption.keys"
TTL_SECONDS = 1.0
PROBE_CONTEXT = b"minibrain.probe"
LABELS = {
    LOCAL: "Local key file",
    VAULT: "HashiCorp Vault Transit",
    HSM: "PKCS#11 HSM",
    KMS: "AWS KMS",
    OFF: "Off",
}

Factory = Callable[[Settings, dict[str, Any], bool], KeyProvider]
FACTORIES: dict[str, Factory] = {}

log = logging.getLogger("minibrain.encryption")


class EncryptionError(Exception):
    pass


def key_file(settings: Settings) -> KeyFile:
    explicit = os.environ.get(KEY_ENV, "").strip()
    if explicit:
        return KeyFile(Path(explicit).expanduser(), mounted=True)
    return KeyFile(settings.home / KEY_DIR / KEY_FILE, mounted=False)


def local_provider(settings: Settings, _values: dict[str, Any], may_create: bool) -> KeyProvider:
    return LocalKeys(key_file(settings), may_create)


FACTORIES[LOCAL] = local_provider
FACTORIES[VAULT] = vault_provider
FACTORIES[HSM] = hsm_provider
FACTORIES[KMS] = kms_provider


def provider_settings(values: dict[str, Any], kind: str) -> tuple[tuple[str, str], ...]:
    return tuple(sorted((name, repr(value)) for name, value in values.items() if name.startswith(f"{kind}_")))


def has_live_record(records: list[dict[str, Any]], kind: str) -> bool:
    return any(item.get("provider") == kind and not item.get("retired_at") for item in records)


def build(settings: Settings, kind: str, values: dict[str, Any], records: list[dict[str, Any]]) -> KeyProvider:
    factory = FACTORIES.get(kind)
    if factory is None:
        raise EncryptionError(f"{kind} is not a key provider this minibrain supports")
    return factory(settings, values, not has_live_record(records, kind))


def unmigrated_choice() -> str:
    found = locked_sources().get(POLICY)
    return str(found[1]) if found else LOCAL


def own_sessions(url: str) -> sessionmaker[Session]:
    arguments: dict[str, Any] = {"check_same_thread": False, "timeout": 30} if url.startswith("sqlite") else {}
    return sessionmaker(create_engine(url, poolclass=NullPool, connect_args=arguments), expire_on_commit=False)


class Keys:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.sessions: sessionmaker[Session] | None = None
        self.lock = threading.RLock()
        self.instances: dict[tuple[str, tuple[tuple[str, str], ...]], KeyProvider] = {}
        self.loaded: tuple[float, dict[str, Any], list[dict[str, Any]]] | None = None

    def attach(self, sessions: sessionmaker[Session]) -> None:
        self.sessions = sessions
        self.invalidate()

    def invalidate(self) -> None:
        with self.lock:
            self.loaded = None

    def state(self) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        with self.lock:
            if self.loaded is not None and time.monotonic() - self.loaded[0] < TTL_SECONDS:
                return self.loaded[1], self.loaded[2]
            if self.sessions is None:
                self.sessions = own_sessions(self.settings.database_url)
            with self.sessions() as session:
                try:
                    values = dict(load_policy(session).values)
                    records = records_of(session)
                except SQLAlchemyError:
                    if inspect(session.connection()).has_table("settings"):
                        raise
                    session.rollback()
                    values, records = {POLICY: unmigrated_choice()}, []
            self.loaded = (time.monotonic(), values, records)
            return values, records

    def kind(self) -> str:
        return str(self.state()[0].get(POLICY, LOCAL))

    def sealing(self) -> bool:
        return self.kind() != OFF

    def provider(self, kind: str) -> KeyProvider:
        values, records = self.state()
        cache_key = (kind, provider_settings(values, kind))
        with self.lock:
            found = self.instances.get(cache_key)
            if found is None:
                found = build(self.settings, kind, values, records)
                self.instances[cache_key] = found
            return found

    def target(self) -> KeyProvider:
        kind = self.kind()
        if kind == OFF:
            raise EncryptionError("encryption at rest is off")
        return self.provider(kind)

    def secrets_provider(self) -> KeyProvider:
        return self.target() if self.sealing() else self.provider(LOCAL)

    def wrap(self, key: bytes, context: bytes) -> Wrapped:
        return self.target().wrap(key, context)

    def unwrap(self, wrapped: Wrapped, context: bytes) -> bytes:
        return self.provider(wrapped.provider).unwrap(wrapped, context)

    def is_current(self, wrapped: Wrapped) -> bool:
        if not self.sealing():
            return True
        target = self.target()
        return wrapped.provider == target.kind and wrapped.key == target.current()


KEYS: dict[tuple[str, str], Keys] = {}
KEYS_LOCK = threading.Lock()


def keys_for(settings: Settings) -> Keys:
    index = (str(settings.home), settings.database_url)
    with KEYS_LOCK:
        if index not in KEYS:
            KEYS[index] = Keys(settings)
        return KEYS[index]


def records_of(session: Session) -> list[dict[str, Any]]:
    return list(read(session, RECORDS, []) or [])


def record(session: Session, kind: str, ref: str, actor: str, label: str = "") -> bool:
    records = records_of(session)
    if any(item.get("provider") == kind and item.get("key") == ref and not item.get("retired_at") for item in records):
        return False
    entry = {"provider": kind, "key": ref, "label": label, "created_at": now().isoformat(), "created_by": actor}
    write(session, RECORDS, [*records, entry])
    return True


def retire_records(session: Session, keep: set[tuple[str, str]]) -> list[dict[str, Any]]:
    records = records_of(session)
    retired: list[dict[str, Any]] = []
    stamp = now().isoformat()
    for item in records:
        if not item.get("retired_at") and (item.get("provider"), item.get("key")) not in keep:
            item["retired_at"] = stamp
            retired.append(item)
    if retired:
        write(session, RECORDS, records)
    return retired


def probe(provider: KeyProvider) -> None:
    key = new_key()
    try:
        opened = provider.unwrap(provider.wrap(key, PROBE_CONTEXT), PROBE_CONTEXT)
    except (KeyUnavailableError, EncryptionError):
        raise
    except Exception as error:
        raise EncryptionError(f"{LABELS.get(provider.kind, provider.kind)} failed a test wrap: {error}") from error
    if opened != key:
        raise EncryptionError(f"{LABELS.get(provider.kind, provider.kind)} returned a different key than it wrapped")


def check_switch(session: Session, settings: Settings, actor: str) -> None:
    values = dict(load_policy(session).values)
    kind = str(values.get(POLICY, LOCAL))
    if kind == OFF:
        return
    try:
        provider = build(settings, kind, values, records_of(session))
        probe(provider)
        current, where = provider.current(), provider.describe()
    except KeyUnavailableError as error:
        raise EncryptionError(str(error)) from error
    if record(session, kind, current, actor, where):
        detail = {"provider": kind, "key": current, "where": where}
        session.add(AuditEvent(actor=actor, action="encryption.key", target=f"{kind}:{current}", detail=detail))


def ensure_master_key(session: Session, keys: Keys, actor: str) -> None:
    try:
        if not keys.sealing():
            return
        target = keys.target()
        current = target.current()
    except Exception as error:
        log.error("encryption at rest cannot reach its master key: %s", error)
        return
    record(session, target.kind, current, actor, target.describe())
