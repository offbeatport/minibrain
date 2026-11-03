import base64
import secrets
import unicodedata

from cryptography.exceptions import InvalidKey
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

SCHEME = "pbkdf2-sha256"
ITERATIONS = 600_000
SALT_BYTES = 16
KEY_BYTES = 32
MIN_LENGTH = 12
MAX_LENGTH = 1024
UNUSED_SALT = bytes(SALT_BYTES)


class PasswordError(Exception):
    pass


def check_strength(password: str) -> None:
    if len(password) < MIN_LENGTH:
        raise PasswordError(f"Use at least {MIN_LENGTH} characters")
    if len(password) > MAX_LENGTH:
        raise PasswordError(f"Use at most {MAX_LENGTH} characters")
    if not password.strip():
        raise PasswordError("A password cannot be only spaces")


def normalized(password: str) -> bytes:
    return unicodedata.normalize("NFKC", password).encode()


def kdf(salt: bytes, iterations: int) -> PBKDF2HMAC:
    return PBKDF2HMAC(algorithm=hashes.SHA256(), length=KEY_BYTES, salt=salt, iterations=iterations)


def encoded(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decoded(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(SALT_BYTES)
    key = kdf(salt, ITERATIONS).derive(normalized(password))
    return f"{SCHEME}${ITERATIONS}${encoded(salt)}${encoded(key)}"


def verify_password(password: str, stored: str | None) -> bool:
    parts = (stored or "").split("$")
    if len(parts) != 4 or parts[0] != SCHEME:
        kdf(UNUSED_SALT, ITERATIONS).derive(normalized(password))
        return False
    _, iterations, salt, key = parts
    try:
        kdf(decoded(salt), int(iterations)).verify(normalized(password), decoded(key))
    except InvalidKey:
        return False
    return True
