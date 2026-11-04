import hashlib
import threading
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

from minibrain.encryption.envelope import KEY_BYTES, EnvelopeError, Wrapped
from minibrain.encryption.providers import KeyUnavailableError

KMS = "kms"
CONTEXT_NAME = "minibrain:context"
DESCRIBE_SECONDS = 300.0
ROTATION_NOTE = (
    "AWS KMS rotates a key's material itself (automatic or on-demand rotation in AWS), and old material keeps "
    "decrypting. To move every data key to another KMS key, set its ARN as the AWS KMS key, then rotate here"
)


@dataclass(frozen=True)
class KmsConfig:
    key: str
    region: str
    endpoint: str = ""
    fips: bool = False


def config_from(values: dict[str, Any]) -> KmsConfig:
    key = str(values.get("kms_key") or "").strip()
    region = str(values.get("kms_region") or "").strip()
    endpoint = str(values.get("kms_endpoint") or "").strip().rstrip("/")
    if not key:
        raise KeyUnavailableError("AWS KMS needs a key ARN, alias ARN or key ID")
    if not region and key.startswith("arn:"):
        region = key.split(":")[3]
    if not region:
        raise KeyUnavailableError("AWS KMS needs a region, or a key ARN that names one")
    if endpoint and urlparse(endpoint).scheme != "https":
        raise KeyUnavailableError("the AWS KMS endpoint must be an https:// URL")
    return KmsConfig(key=key, region=region, endpoint=endpoint, fips=bool(values.get("kms_fips")))


def encryption_context(context: bytes) -> dict[str, str]:
    return {CONTEXT_NAME: hashlib.sha256(context).hexdigest()}


def make_client(config: KmsConfig) -> Any:
    from botocore.config import Config
    from botocore.session import get_session

    settings = Config(
        use_fips_endpoint=config.fips,
        retries={"max_attempts": 3, "mode": "standard"},
        connect_timeout=5,
        read_timeout=15,
    )
    return get_session().create_client(
        "kms", region_name=config.region, endpoint_url=config.endpoint or None, config=settings
    )


class AwsKms:
    kind = KMS

    def __init__(self, config: KmsConfig, client: Any) -> None:
        self.config = config
        self.client = client
        self.lock = threading.Lock()
        self.described: tuple[float, str] | None = None

    def call(self, operation: str, **arguments: Any) -> dict[str, Any]:
        from botocore.exceptions import BotoCoreError, ClientError

        try:
            return getattr(self.client, operation)(**arguments)
        except ClientError as error:
            code = str(error.response.get("Error", {}).get("Code", ""))
            if code in ("InvalidCiphertextException", "IncorrectKeyException"):
                raise EnvelopeError(f"AWS KMS could not open the data key: {code}") from error
            raise KeyUnavailableError(f"AWS KMS refused {operation} on {self.config.key}: {error}") from error
        except BotoCoreError as error:
            raise KeyUnavailableError(f"AWS KMS in {self.config.region} is unreachable: {error}") from error

    def current(self) -> str:
        with self.lock:
            cached = self.described
        if cached is not None and time.monotonic() - cached[0] < DESCRIBE_SECONDS:
            return cached[1]
        metadata = self.call("describe_key", KeyId=self.config.key).get("KeyMetadata") or {}
        if metadata.get("KeySpec", "SYMMETRIC_DEFAULT") != "SYMMETRIC_DEFAULT":
            raise KeyUnavailableError(f"{self.config.key} is not a symmetric encryption key")
        if metadata.get("KeyState", "Enabled") != "Enabled":
            raise KeyUnavailableError(f"{self.config.key} is {metadata.get('KeyState')}")
        arn = str(metadata.get("Arn") or self.config.key)
        with self.lock:
            self.described = (time.monotonic(), arn)
        return arn

    def wrap(self, key: bytes, context: bytes) -> Wrapped:
        found = self.call(
            "encrypt", KeyId=self.config.key, Plaintext=key, EncryptionContext=encryption_context(context)
        )
        return Wrapped(KMS, str(found.get("KeyId") or self.current()), bytes(found["CiphertextBlob"]))

    def unwrap(self, wrapped: Wrapped, context: bytes) -> bytes:
        found = self.call(
            "decrypt",
            CiphertextBlob=wrapped.blob,
            KeyId=wrapped.key,
            EncryptionContext=encryption_context(context),
        )
        opened = bytes(found.get("Plaintext") or b"")
        if len(opened) != KEY_BYTES:
            raise EnvelopeError("AWS KMS returned a data key of the wrong size")
        return opened

    def rotate(self) -> str:
        raise KeyUnavailableError(ROTATION_NOTE)

    def retire(self, keep: set[str]) -> list[str]:
        return []

    def describe(self) -> str:
        endpoint = self.client.meta.endpoint_url if hasattr(self.client, "meta") else self.config.endpoint
        return f"{self.config.key} via {endpoint}"


CLIENTS: dict[str, Any] = {}


def kms_provider(_settings: Any, values: dict[str, Any], _may_create: bool) -> AwsKms:
    config = config_from(values)
    return AwsKms(config, CLIENTS.get(config.key) or make_client(config))
