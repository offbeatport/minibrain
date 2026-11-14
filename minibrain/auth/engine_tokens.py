import hashlib
import hmac

from minibrain.settings import Settings

PREFIX = "engine."
KEY_FILE = "engine_token"


def signature(settings: Settings, pool: str) -> str:
    return hmac.new(settings.secret(KEY_FILE).encode(), pool.encode(), hashlib.sha256).hexdigest()


def engine_token(settings: Settings, pool: str) -> str:
    return f"{PREFIX}{pool}.{signature(settings, pool)}"


def engine_pool(settings: Settings, token: str) -> str | None:
    if not token.startswith(PREFIX):
        return None
    pool, _, given = token.removeprefix(PREFIX).rpartition(".")
    if not pool or not hmac.compare_digest(given, signature(settings, pool)):
        return None
    return pool
