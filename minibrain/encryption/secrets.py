import base64
import binascii
import json

from minibrain.encryption.envelope import EnvelopeError, Wrapped, new_key, open_bytes, seal_bytes
from minibrain.encryption.keys import Keys

FORMAT = "envelope1"
LEGACY = "aesgcm1"


def seal_text(keys: Keys, plaintext: str, context: str) -> str:
    key = new_key()
    wrapped = keys.secrets_provider().wrap(key, context.encode())
    sealed = seal_bytes(key, plaintext.encode(), context.encode())
    body = {"wrap": wrapped.as_dict(), "data": base64.b64encode(sealed).decode()}
    encoded = json.dumps(body, separators=(",", ":"), sort_keys=True)
    return f"{FORMAT}:{base64.b64encode(encoded.encode()).decode()}"


def parse(token: str) -> tuple[Wrapped, bytes]:
    try:
        body = json.loads(base64.b64decode(token.partition(":")[2], validate=True))
        return Wrapped.from_dict(body["wrap"]), base64.b64decode(str(body["data"]), validate=True)
    except (binascii.Error, ValueError, KeyError, TypeError) as error:
        raise EnvelopeError("the sealed value is damaged") from error


def wrapped_of(token: str) -> Wrapped | None:
    return parse(token)[0] if token.startswith(f"{FORMAT}:") else None


def open_legacy(keys: Keys, token: str, context: str) -> str:
    ring = keys.local_ring()
    if ring is None:
        raise EnvelopeError("the secret was sealed with the old master key file, which is not on this server")
    try:
        raw = base64.b64decode(token.partition(":")[2], validate=True)
    except (binascii.Error, ValueError) as error:
        raise EnvelopeError("the sealed value is damaged") from error
    for key in ring.legacy_keys():
        try:
            return open_bytes(key, raw, context.encode()).decode()
        except EnvelopeError:
            continue
    raise EnvelopeError("the sealed value does not open with any local master key")


def open_text(keys: Keys, token: str, context: str) -> str:
    kind = token.partition(":")[0]
    if kind == LEGACY:
        return open_legacy(keys, token, context)
    if kind != FORMAT:
        raise EnvelopeError("the stored secret is in an unknown format")
    wrapped, sealed = parse(token)
    key = keys.unwrap(wrapped, context.encode())
    return open_bytes(key, sealed, context.encode()).decode()


def needs_reseal(keys: Keys, token: str) -> bool:
    if not token:
        return False
    wrapped = wrapped_of(token)
    if wrapped is None:
        return True
    provider = keys.secrets_provider()
    return wrapped.provider != provider.kind or wrapped.key != provider.current()
