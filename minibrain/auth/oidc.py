import base64
import json
import secrets
import ssl
import time
from dataclasses import asdict, dataclass
from typing import Any, cast
from urllib.parse import urlparse

import httpx2
from authlib.integrations.base_client import OAuthError
from authlib.integrations.httpx_client import OAuth2Client
from authlib.oauth2.rfc6749.errors import OAuth2Error
from joserfc import jwt
from joserfc.errors import JoseError
from joserfc.jwk import KeySet

from minibrain.auth.accounts import csrf_for, csrf_matches
from minibrain.auth.config import OidcConfig

PENDING_COOKIE = "minibrain_oidc"
PENDING_PATH = "/api/auth/oidc"
PENDING_SECONDS = 600
TIMEOUT_SECONDS = 10.0
LEEWAY_SECONDS = 60
ALGORITHMS = ("RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512")
DISCOVERY = "/.well-known/openid-configuration"


class OidcError(Exception):
    pass


@dataclass(frozen=True)
class Provider:
    issuer: str
    authorization_endpoint: str
    token_endpoint: str
    jwks_uri: str


@dataclass(frozen=True)
class Pending:
    state: str
    nonce: str
    verifier: str
    next: str
    expires: int


@dataclass(frozen=True)
class OidcClaims:
    subject: str
    email: str | None
    name: str | None
    groups: list[str]


def encoded(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decoded(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def seal(key: bytes, pending: Pending) -> str:
    payload = encoded(json.dumps(asdict(pending), sort_keys=True).encode())
    return f"{payload}.{csrf_for(key, f'oidc:{payload}')}"


def unseal(key: bytes, value: str | None) -> Pending:
    payload, _, signature = (value or "").partition(".")
    if not payload or not csrf_matches(key, f"oidc:{payload}", signature):
        raise OidcError("The sign-in took too long or started in another browser. Try again.")
    found = json.loads(decoded(payload))
    pending = Pending(
        state=str(found["state"]),
        nonce=str(found["nonce"]),
        verifier=str(found["verifier"]),
        next=safe_next(found.get("next")),
        expires=int(found["expires"]),
    )
    if pending.expires < time.time():
        raise OidcError("The sign-in took too long. Try again.")
    return pending


def safe_next(path: str | None) -> str:
    if not path or not path.startswith("/") or path.startswith("//") or "\\" in path:
        return "/"
    return path


def groups_from(value: Any) -> list[str]:
    items = value if isinstance(value, list) else str(value or "").split(",")
    found: list[str] = []
    for item in items:
        group = str(item).strip()
        if group and group not in found:
            found.append(group)
    return found


def endpoint(document: dict[str, Any], name: str) -> str:
    value = document.get(name)
    if not isinstance(value, str) or urlparse(value).scheme not in ("https", "http"):
        raise OidcError(f"The identity provider's configuration has no {name}")
    return value


class OidcClient:
    def __init__(self, config: OidcConfig, transport: httpx2.BaseTransport | None = None) -> None:
        self.config = config
        self.transport = transport
        self.provider: Provider | None = None
        self.keys: KeySet | None = None

    def verify(self) -> ssl.SSLContext | bool:
        return ssl.create_default_context(cafile=self.config.ca_bundle) if self.config.ca_bundle else True

    def fetch(self, url: str) -> dict[str, Any]:
        try:
            with httpx2.Client(
                timeout=TIMEOUT_SECONDS, verify=self.verify(), trust_env=False, transport=self.transport
            ) as client:
                response = client.get(url, headers={"Accept": "application/json"})
                response.raise_for_status()
                return response.json()
        except (httpx2.HTTPError, ValueError) as error:
            raise OidcError(f"Could not reach the identity provider: {error}") from error

    def discover(self) -> Provider:
        if self.provider is None:
            issuer = self.config.issuer.rstrip("/")
            document = self.fetch(issuer + DISCOVERY)
            if str(document.get("issuer", "")).rstrip("/") != issuer:
                raise OidcError("The identity provider reports a different issuer than auth.oidc.issuer")
            self.provider = Provider(
                issuer=str(document["issuer"]),
                authorization_endpoint=endpoint(document, "authorization_endpoint"),
                token_endpoint=endpoint(document, "token_endpoint"),
                jwks_uri=endpoint(document, "jwks_uri"),
            )
        return self.provider

    def keyset(self, refresh: bool = False) -> KeySet:
        if self.keys is None or refresh:
            self.keys = KeySet.import_key_set(cast(Any, self.fetch(self.discover().jwks_uri)))
        return self.keys

    def oauth(self, redirect_uri: str) -> OAuth2Client:
        return OAuth2Client(
            client_id=self.config.client_id,
            client_secret=self.config.client_secret,
            token_endpoint_auth_method="client_secret_basic" if self.config.client_secret else "none",
            scope=" ".join(self.config.scopes),
            redirect_uri=redirect_uri,
            code_challenge_method="S256",
            timeout=TIMEOUT_SECONDS,
            verify=self.verify(),
            trust_env=False,
            transport=self.transport,
        )

    def start(self, redirect_uri: str, next_path: str | None) -> tuple[str, Pending]:
        provider = self.discover()
        pending = Pending(
            state=secrets.token_urlsafe(32),
            nonce=secrets.token_urlsafe(32),
            verifier=secrets.token_urlsafe(64),
            next=safe_next(next_path),
            expires=int(time.time()) + PENDING_SECONDS,
        )
        client = self.oauth(redirect_uri)
        try:
            url, _ = client.create_authorization_url(
                provider.authorization_endpoint,
                state=pending.state,
                nonce=pending.nonce,
                code_verifier=pending.verifier,
            )
        finally:
            cast(httpx2.Client, client).close()
        return url, pending

    def finish(self, redirect_uri: str, pending: Pending, code: str, state: str) -> OidcClaims:
        if not secrets.compare_digest(state.encode(), pending.state.encode()):
            raise OidcError("The sign-in response does not match the request. Try again.")
        provider = self.discover()
        client = self.oauth(redirect_uri)
        try:
            token = client.fetch_token(provider.token_endpoint, code=code, code_verifier=pending.verifier)
        except (OAuth2Error, OAuthError, httpx2.HTTPError, ValueError) as error:
            raise OidcError(f"The identity provider refused the sign-in: {error}") from error
        finally:
            cast(httpx2.Client, client).close()
        id_token = token.get("id_token")
        if not isinstance(id_token, str):
            raise OidcError("The identity provider sent no ID token")
        return self.claims_of(id_token, provider, pending.nonce)

    def verified(self, id_token: str) -> dict[str, Any]:
        try:
            return jwt.decode(id_token, self.keyset(), algorithms=ALGORITHMS).claims
        except JoseError:
            return jwt.decode(id_token, self.keyset(refresh=True), algorithms=ALGORITHMS).claims

    def claims_of(self, id_token: str, provider: Provider, nonce: str) -> OidcClaims:
        try:
            claims = self.verified(id_token)
            jwt.JWTClaimsRegistry(
                leeway=LEEWAY_SECONDS,
                iss={"essential": True, "value": provider.issuer},
                aud={"essential": True, "value": self.config.client_id},
                sub={"essential": True},
                exp={"essential": True},
                nonce={"essential": True, "value": nonce},
            ).validate(claims)
        except (JoseError, ValueError) as error:
            raise OidcError(f"The ID token did not verify: {error}") from error
        name = claims.get("name") or claims.get("preferred_username") or claims.get("email")
        email = claims.get("email")
        return OidcClaims(
            subject=str(claims["sub"]),
            email=str(email) if email else None,
            name=str(name) if name else None,
            groups=groups_from(claims.get(self.config.groups_claim)),
        )
