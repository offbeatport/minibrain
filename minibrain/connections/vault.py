import base64
import binascii
import os
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from minibrain.settings import Settings

KEY_ENV = "MINIBRAIN_MASTER_KEY_FILE"
KEY_FILE = "master.key"
KEY_BYTES = 32
NONCE_BYTES = 12
FORMAT = "aesgcm1"
UNREADABLE = "the stored secret cannot be decrypted with this install's master key; enter it again"


class VaultError(Exception):
    pass


def configured_path() -> Path | None:
    explicit = os.environ.get(KEY_ENV, "").strip()
    return Path(explicit).expanduser() if explicit else None


def key_path(settings: Settings) -> Path:
    return configured_path() or settings.home / "secrets" / KEY_FILE


def create_key(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return
    with os.fdopen(descriptor, "w") as stream:
        stream.write(base64.b64encode(AESGCM.generate_key(bit_length=KEY_BYTES * 8)).decode())


def master_key(settings: Settings) -> bytes:
    path = key_path(settings)
    if not path.is_file():
        if configured_path() is not None:
            raise VaultError(f"the master key file {path} named by {KEY_ENV} does not exist")
        create_key(path)
    try:
        key = base64.b64decode(path.read_text().strip(), validate=True)
    except (binascii.Error, ValueError) as error:
        raise VaultError(f"{path} does not hold a base64 master key") from error
    if len(key) != KEY_BYTES:
        raise VaultError(f"{path} must hold a 256-bit key, such as the output of openssl rand -base64 32")
    return key


def seal(settings: Settings, plaintext: str, context: str) -> str:
    nonce = os.urandom(NONCE_BYTES)
    sealed = AESGCM(master_key(settings)).encrypt(nonce, plaintext.encode(), context.encode())
    return f"{FORMAT}:{base64.b64encode(nonce + sealed).decode()}"


def unseal(settings: Settings, token: str, context: str) -> str:
    kind, _, body = token.partition(":")
    if kind != FORMAT:
        raise VaultError("the stored secret is in an unknown format; enter it again")
    try:
        raw = base64.b64decode(body, validate=True)
        opened = AESGCM(master_key(settings)).decrypt(raw[:NONCE_BYTES], raw[NONCE_BYTES:], context.encode())
    except (binascii.Error, ValueError, InvalidTag) as error:
        raise VaultError(UNREADABLE) from error
    return opened.decode()
