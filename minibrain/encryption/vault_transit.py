import base64
import hashlib
import hmac
import os
import ssl
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse

import httpx

from minibrain.encryption.envelope import KEY_BYTES, EnvelopeError, Wrapped
from minibrain.encryption.providers import KeyUnavailableError

VAULT = "vault"
SIGN_IN_ENV = "MINIBRAIN_VAULT_TOKEN"
APPROLE_ENV = "MINIBRAIN_VAULT_SECRET_ID"
DIRECT = "token"
APPROLE = "approle"
KEY_TYPES = ("aes256-gcm96",)
VERSION_SECONDS = 30.0
RENEW_MARGIN = 60.0
TIMEOUT = httpx.Timeout(10.0, connect=5.0)
DIGEST = 32


@dataclass(frozen=True)
class VaultConfig:
    address: str
    mount: str = "transit"
    key: str = "minibrain"
    namespace: str = ""
    auth: str = DIRECT
    role_id: str = ""
    auth_mount: str = APPROLE
    ca_bundle: str = ""


def secret_from_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if value:
        return value
    path = os.environ.get(f"{name}_FILE", "").strip()
    if path:
        found = Path(path).expanduser()
        if not found.is_file():
            raise KeyUnavailableError(f"{name}_FILE names {found}, which does not exist")
        return found.read_text().strip()
    return ""


def config_from(values: dict[str, Any]) -> VaultConfig:
    address = str(values.get("vault_address") or "").strip().rstrip("/")
    parsed = urlparse(address)
    if parsed.scheme not in ("https", "http") or not parsed.hostname:
        raise KeyUnavailableError("Vault address must be an https:// URL, such as https://vault.internal:8200")
    auth = str(values.get("vault_auth") or DIRECT)
    if auth not in (DIRECT, APPROLE):
        raise KeyUnavailableError("Vault sign-in is token or approle")
    config = VaultConfig(
        address=address,
        mount=str(values.get("vault_mount") or "transit").strip().strip("/"),
        key=str(values.get("vault_key") or "minibrain").strip(),
        namespace=str(values.get("vault_namespace") or "").strip().strip("/"),
        auth=auth,
        role_id=str(values.get("vault_role_id") or "").strip(),
        auth_mount=str(values.get("vault_auth_mount") or APPROLE).strip().strip("/"),
        ca_bundle=str(values.get("vault_ca_bundle") or "").strip(),
    )
    if not config.mount or not config.key:
        raise KeyUnavailableError("Vault needs a Transit mount and a key name")
    if auth == APPROLE and not config.role_id:
        raise KeyUnavailableError("Vault AppRole sign-in needs a role ID")
    return config


def tls_context(ca_bundle: str) -> ssl.SSLContext:
    context = ssl.create_default_context(cafile=ca_bundle or None)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    return context


def binding(context: bytes) -> bytes:
    return hashlib.sha256(b"minibrain.vault:" + context).digest()


class VaultTransit:
    kind = VAULT

    def __init__(self, config: VaultConfig, transport: httpx.BaseTransport | None = None) -> None:
        self.config = config
        verify: Any = True if transport is not None else tls_context(config.ca_bundle)
        headers = {"X-Vault-Namespace": config.namespace} if config.namespace else {}
        self.http = httpx.Client(
            base_url=config.address, timeout=TIMEOUT, verify=verify, transport=transport, headers=headers
        )
        self.lock = threading.Lock()
        self.token = ""
        self.expires = 0.0
        self.version: tuple[float, int] | None = None

    def path(self, *parts: str) -> str:
        return "/v1/" + "/".join(quote(part, safe="/") for part in parts)

    def login(self) -> str:
        if self.config.auth == DIRECT:
            token = secret_from_env(SIGN_IN_ENV)
            if not token:
                raise KeyUnavailableError(f"set {SIGN_IN_ENV} or {SIGN_IN_ENV}_FILE to a Vault token")
            return token
        with self.lock:
            if self.token and time.monotonic() < self.expires - RENEW_MARGIN:
                return self.token
            secret_id = secret_from_env(APPROLE_ENV)
            if not secret_id:
                raise KeyUnavailableError(f"set {APPROLE_ENV} or {APPROLE_ENV}_FILE to the AppRole secret ID")
            body = {"role_id": self.config.role_id, "secret_id": secret_id}
            found = self.send("POST", self.path("auth", self.config.auth_mount, "login"), body, signed=False)
            auth = found.get("auth") or {}
            self.token = str(auth.get("client_token") or "")
            if not self.token:
                raise KeyUnavailableError("Vault AppRole login returned no token")
            lease = float(auth.get("lease_duration") or 0)
            self.expires = time.monotonic() + (lease if lease > 0 else 3600.0)
            return self.token

    def send(self, method: str, path: str, body: dict[str, Any] | None = None, signed: bool = True) -> dict[str, Any]:
        headers = {"X-Vault-Token": self.login()} if signed else {}
        try:
            response = self.http.request(method, path, json=body, headers=headers)
        except httpx.HTTPError as error:
            raise KeyUnavailableError(f"Vault at {self.config.address} is unreachable: {error}") from error
        if response.status_code == 403 and signed and self.config.auth == APPROLE:
            with self.lock:
                self.token = ""
        if response.status_code >= 400:
            errors = "; ".join(str(item) for item in (safe_json(response).get("errors") or [])) or response.text[:200]
            raise KeyUnavailableError(f"Vault refused {method} {path} ({response.status_code}): {errors}")
        return safe_json(response)

    def key_info(self) -> dict[str, Any]:
        found = self.send("GET", self.path(self.config.mount, "keys", self.config.key))
        data = found.get("data") or {}
        if data.get("type") not in KEY_TYPES:
            raise KeyUnavailableError(
                f"Vault key {self.config.key} must be of type aes256-gcm96, not {data.get('type')}"
            )
        return data

    def latest(self, fresh: bool = False) -> int:
        with self.lock:
            cached = self.version
        if cached is not None and not fresh and time.monotonic() - cached[0] < VERSION_SECONDS:
            return cached[1]
        version = int(self.key_info().get("latest_version") or 0)
        with self.lock:
            self.version = (time.monotonic(), version)
        return version

    def ref(self, version: int) -> str:
        return f"{self.config.mount}/{self.config.key}:v{version}"

    def current(self) -> str:
        return self.ref(self.latest())

    def wrap(self, key: bytes, context: bytes) -> Wrapped:
        plaintext = base64.b64encode(binding(context) + key).decode()
        found = self.send("POST", self.path(self.config.mount, "encrypt", self.config.key), {"plaintext": plaintext})
        ciphertext = str((found.get("data") or {}).get("ciphertext") or "")
        parts = ciphertext.split(":")
        if len(parts) != 3 or parts[0] != "vault" or not parts[1].startswith("v"):
            raise KeyUnavailableError("Vault returned a ciphertext minibrain does not recognise")
        return Wrapped(VAULT, self.ref(int(parts[1][1:])), ciphertext.encode())

    def unwrap(self, wrapped: Wrapped, context: bytes) -> bytes:
        body = {"ciphertext": wrapped.blob.decode()}
        found = self.send("POST", self.path(self.config.mount, "decrypt", self.config.key), body)
        try:
            opened = base64.b64decode(str((found.get("data") or {}).get("plaintext") or ""), validate=True)
        except ValueError as error:
            raise EnvelopeError("Vault returned a data key that is not base64") from error
        if len(opened) != DIGEST + KEY_BYTES or not hmac.compare_digest(opened[:DIGEST], binding(context)):
            raise EnvelopeError("the data key Vault returned belongs to another file")
        return opened[DIGEST:]

    def rotate(self) -> str:
        self.send("POST", self.path(self.config.mount, "keys", self.config.key, "rotate"))
        return self.ref(self.latest(fresh=True))

    def retire(self, keep: set[str]) -> list[str]:
        return []

    def describe(self) -> str:
        return f"{self.config.address} {self.config.mount}/{self.config.key}"


def safe_json(response: httpx.Response) -> dict[str, Any]:
    try:
        found = response.json()
    except ValueError:
        return {}
    return found if isinstance(found, dict) else {}


TRANSPORTS: dict[str, httpx.BaseTransport] = {}


def vault_provider(_settings: Any, values: dict[str, Any], _may_create: bool) -> VaultTransit:
    config = config_from(values)
    return VaultTransit(config, TRANSPORTS.get(config.address))
