import hashlib
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from minibrain.encryption.envelope import KEY_BYTES, EnvelopeError, Wrapped
from minibrain.encryption.providers import KeyUnavailableError
from minibrain.encryption.vault_transit import secret_from_env

HSM = "hsm"
PIN_ENV = "MINIBRAIN_HSM_PIN"
IV_BYTES = 12
TAG_BITS = 128
INSTALL_HINT = "install the HSM support with pip install 'minibrain[hsm]' (PyKCS11)"


@dataclass(frozen=True)
class HsmConfig:
    library: str
    token: str
    label: str = "minibrain-master"


class Token(Protocol):
    def keys(self, label: str) -> dict[int, Any]: ...

    def generate(self, label: str, version: int) -> Any: ...

    def encrypt(self, key: Any, iv: bytes, aad: bytes, data: bytes) -> bytes: ...

    def decrypt(self, key: Any, iv: bytes, aad: bytes, data: bytes) -> bytes: ...


def config_from(values: dict[str, Any]) -> HsmConfig:
    library = str(values.get("hsm_library") or "").strip()
    token = str(values.get("hsm_token") or "").strip()
    label = str(values.get("hsm_key") or "minibrain-master").strip()
    if not library or not token or not label:
        raise KeyUnavailableError("the PKCS#11 HSM needs its library path, a token label and a key label")
    return HsmConfig(library=library, token=token, label=label)


def binding(context: bytes) -> bytes:
    return hashlib.sha256(b"minibrain.hsm:" + context).digest()


def token_label(raw: str) -> str:
    return raw.replace("\x00", " ").strip()


class Pkcs11Token:
    def __init__(self, config: HsmConfig, pin: str) -> None:
        try:
            import PyKCS11
        except ImportError as error:
            raise KeyUnavailableError(f"PKCS#11 needs PyKCS11: {INSTALL_HINT}") from error
        self.api: Any = PyKCS11
        if not Path(config.library).is_file():
            raise KeyUnavailableError(f"the PKCS#11 library {config.library} does not exist")
        self.library: Any = self.api.PyKCS11Lib()
        self.library.load(config.library)
        slot = next(
            (
                found
                for found in self.library.getSlotList(tokenPresent=True)
                if token_label(self.library.getTokenInfo(found).label) == config.token
            ),
            None,
        )
        if slot is None:
            raise KeyUnavailableError(f"no PKCS#11 token labelled {config.token} in {config.library}")
        self.session: Any = self.library.openSession(slot, PyKCS11.CKF_SERIAL_SESSION | PyKCS11.CKF_RW_SESSION)
        try:
            self.session.login(pin)
        except PyKCS11.PyKCS11Error as error:
            if error.value != PyKCS11.CKR_USER_ALREADY_LOGGED_IN:
                raise KeyUnavailableError(f"the HSM refused the PIN for token {config.token}: {error}") from error

    def keys(self, label: str) -> dict[int, Any]:
        api = self.api
        template = [(api.CKA_CLASS, api.CKO_SECRET_KEY), (api.CKA_KEY_TYPE, api.CKK_AES), (api.CKA_LABEL, label)]
        found: dict[int, Any] = {}
        for handle in self.session.findObjects(template):
            raw = self.session.getAttributeValue(handle, [api.CKA_ID])[0]
            text = bytes(raw or b"").decode(errors="replace")
            if text.isdigit():
                found[int(text)] = handle
        return found

    def generate(self, label: str, version: int) -> Any:
        api = self.api
        template = [
            (api.CKA_CLASS, api.CKO_SECRET_KEY),
            (api.CKA_KEY_TYPE, api.CKK_AES),
            (api.CKA_VALUE_LEN, KEY_BYTES),
            (api.CKA_LABEL, label),
            (api.CKA_ID, str(version).encode()),
            (api.CKA_TOKEN, api.CK_TRUE),
            (api.CKA_PRIVATE, api.CK_TRUE),
            (api.CKA_SENSITIVE, api.CK_TRUE),
            (api.CKA_EXTRACTABLE, api.CK_FALSE),
            (api.CKA_ENCRYPT, api.CK_TRUE),
            (api.CKA_DECRYPT, api.CK_TRUE),
        ]
        return self.session.generateKey(template, api.MechanismAESGENERATEKEY)

    def encrypt(self, key: Any, iv: bytes, aad: bytes, data: bytes) -> bytes:
        return bytes(self.session.encrypt(key, data, self.api.AES_GCM_Mechanism(iv, aad, TAG_BITS)))

    def decrypt(self, key: Any, iv: bytes, aad: bytes, data: bytes) -> bytes:
        try:
            return bytes(self.session.decrypt(key, data, self.api.AES_GCM_Mechanism(iv, aad, TAG_BITS)))
        except self.api.PyKCS11Error as error:
            raise EnvelopeError(f"the HSM could not open the data key: {error}") from error


class HsmKeys:
    kind = HSM

    def __init__(self, config: HsmConfig, token: Token, may_create: bool) -> None:
        self.config = config
        self.token = token
        self.lock = threading.Lock()
        with self.lock:
            versions = token.keys(config.label)
            if not versions:
                if not may_create:
                    raise KeyUnavailableError(f"the HSM has no AES key labelled {config.label} on {config.token}")
                token.generate(config.label, 1)

    def ref(self, version: int) -> str:
        return f"{self.config.token}/{self.config.label}#{version}"

    def versions(self) -> dict[int, Any]:
        with self.lock:
            found = self.token.keys(self.config.label)
        if not found:
            raise KeyUnavailableError(f"the HSM has no AES key labelled {self.config.label}")
        return found

    def current(self) -> str:
        return self.ref(max(self.versions()))

    def wrap(self, key: bytes, context: bytes) -> Wrapped:
        found = self.versions()
        version = max(found)
        iv = os.urandom(IV_BYTES)
        with self.lock:
            sealed = self.token.encrypt(found[version], iv, binding(context), key)
        return Wrapped(HSM, self.ref(version), iv + sealed)

    def unwrap(self, wrapped: Wrapped, context: bytes) -> bytes:
        prefix, _, version = wrapped.key.rpartition("#")
        if prefix != f"{self.config.token}/{self.config.label}" or not version.isdigit():
            raise KeyUnavailableError(f"{wrapped.key} is not a key on this HSM token and label")
        handle = self.versions().get(int(version))
        if handle is None:
            raise KeyUnavailableError(f"the HSM no longer holds {wrapped.key}")
        with self.lock:
            opened = self.token.decrypt(handle, wrapped.blob[:IV_BYTES], binding(context), wrapped.blob[IV_BYTES:])
        if len(opened) != KEY_BYTES:
            raise EnvelopeError("the HSM returned a data key of the wrong size")
        return opened

    def rotate(self) -> str:
        version = max(self.versions()) + 1
        with self.lock:
            self.token.generate(self.config.label, version)
        return self.ref(version)

    def retire(self, keep: set[str]) -> list[str]:
        return []

    def describe(self) -> str:
        return f"{self.config.library} token {self.config.token} key {self.config.label}"


TOKENS: dict[str, Token] = {}
OPEN: dict[tuple[str, str], Token] = {}
OPEN_LOCK = threading.Lock()


def open_token(config: HsmConfig) -> Token:
    with OPEN_LOCK:
        found = TOKENS.get(config.library) or OPEN.get((config.library, config.token))
        if found is None:
            pin = secret_from_env(PIN_ENV)
            if not pin:
                raise KeyUnavailableError(f"set {PIN_ENV} or {PIN_ENV}_FILE to the HSM user PIN")
            found = Pkcs11Token(config, pin)
            OPEN[(config.library, config.token)] = found
        return found


def hsm_provider(_settings: Any, values: dict[str, Any], may_create: bool) -> HsmKeys:
    return HsmKeys(config_from(values), open_token(config_from(values)), may_create)
