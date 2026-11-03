from collections.abc import Iterable
from typing import Any

REDACTED = "[redacted]"
SECRET_WORDS = (
    "secret",
    "token",
    "password",
    "passwd",
    "credential",
    "authorization",
    "api_key",
    "apikey",
    "access_key",
    "private_key",
)
SHORTEST_SECRET = 8


def secret_name(name: str) -> bool:
    lowered = name.lower()
    return any(word in lowered for word in SECRET_WORDS)


def redact(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: REDACTED if secret_name(str(key)) and isinstance(item, str) and item else redact(item)
            for key, item in value.items()
        }
    if isinstance(value, list | tuple):
        return [redact(item) for item in value]
    return value


def scrub(text: str, secrets: Iterable[str]) -> str:
    for secret in sorted({item for item in secrets if len(item) >= SHORTEST_SECRET}, key=len, reverse=True):
        text = text.replace(secret, REDACTED)
    return text
