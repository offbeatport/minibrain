import base64
import hashlib
import json
import secrets
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse

import httpx2
from joserfc import jwt
from joserfc.jwk import RSAKey

ISSUER = "https://idp.example.test/realms/corp"
CLIENT_ID = "minibrain"
CLIENT_CREDENTIAL = "fake-client-credential"


def challenge_of(verifier: str) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")


@dataclass
class Grant:
    challenge: str
    nonce: str
    redirect_uri: str
    claims: dict[str, Any]


@dataclass
class FakeProvider:
    issuer: str = ISSUER
    claims: dict[str, Any] = field(default_factory=dict)
    token_claims: dict[str, Any] = field(default_factory=dict)
    key: RSAKey = field(default_factory=lambda: RSAKey.generate_key(2048, parameters={"kid": "signing"}))
    signing_key: RSAKey | None = None
    grants: dict[str, Grant] = field(default_factory=dict)
    calls: list[str] = field(default_factory=list)

    def document(self) -> dict[str, Any]:
        return {
            "issuer": self.issuer,
            "authorization_endpoint": f"{ISSUER}/protocol/openid-connect/auth",
            "token_endpoint": f"{ISSUER}/protocol/openid-connect/token",
            "jwks_uri": f"{ISSUER}/protocol/openid-connect/certs",
        }

    def authorize(self, url: str) -> str:
        query = {name: values[0] for name, values in parse_qs(urlparse(url).query).items()}
        expected = query["response_type"] == "code" and query["client_id"] == CLIENT_ID
        if not expected or query["code_challenge_method"] != "S256" or "openid" not in query["scope"].split():
            raise ValueError(f"unexpected authorization request {query}")
        code = secrets.token_urlsafe(16)
        self.grants[code] = Grant(query["code_challenge"], query["nonce"], query["redirect_uri"], dict(self.claims))
        return f"{query['redirect_uri']}?{urlencode({'code': code, 'state': query['state']})}"

    def id_token(self, grant: Grant) -> str:
        now = int(time.time())
        claims = {
            "iss": self.issuer,
            "aud": CLIENT_ID,
            "sub": "user-1",
            "iat": now,
            "exp": now + 300,
            "nonce": grant.nonce,
        }
        claims |= grant.claims | self.token_claims
        return jwt.encode({"alg": "RS256", "kid": "signing"}, claims, self.signing_key or self.key)

    def token(self, request: httpx2.Request) -> httpx2.Response:
        expected = base64.b64encode(f"{CLIENT_ID}:{CLIENT_CREDENTIAL}".encode()).decode()
        if request.headers.get("authorization") != f"Basic {expected}":
            return httpx2.Response(401, json={"error": "invalid_client"})
        form = {name: values[0] for name, values in parse_qs(request.content.decode()).items()}
        grant = self.grants.pop(form.get("code", ""), None)
        if grant is None or form.get("grant_type") != "authorization_code":
            return httpx2.Response(400, json={"error": "invalid_grant"})
        if (
            challenge_of(form.get("code_verifier", "")) != grant.challenge
            or form.get("redirect_uri") != grant.redirect_uri
        ):
            return httpx2.Response(400, json={"error": "invalid_grant", "error_description": "PKCE check failed"})
        body = {"access_token": "access", "token_type": "Bearer", "expires_in": 300, "id_token": self.id_token(grant)}
        return httpx2.Response(200, json=body)

    def handle(self, request: httpx2.Request) -> httpx2.Response:
        url = str(request.url).split("?", 1)[0]
        self.calls.append(url)
        if url == f"{ISSUER}/.well-known/openid-configuration":
            return httpx2.Response(200, json=self.document())
        if url == f"{ISSUER}/protocol/openid-connect/certs":
            return httpx2.Response(200, content=json.dumps({"keys": [self.key.as_dict(private=False)]}))
        if url == f"{ISSUER}/protocol/openid-connect/token" and request.method == "POST":
            return self.token(request)
        return httpx2.Response(404)
