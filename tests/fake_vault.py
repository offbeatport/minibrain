import base64
import json
import os
from dataclasses import dataclass, field

import httpx
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ROOT = "hvs.fake-root"
ROLE_ID = "fake-role-id"
ROLE_PROOF = "fake-secret-id"


@dataclass
class FakeVault:
    key: str = "minibrain"
    mount: str = "transit"
    versions: list[bytes] = field(default_factory=lambda: [AESGCM.generate_key(bit_length=256)])
    tokens: set[str] = field(default_factory=lambda: {ROOT})
    calls: list[str] = field(default_factory=list)
    down: bool = False

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def reply(self, status: int, body: dict) -> httpx.Response:
        return httpx.Response(status, json=body)

    def handle(self, request: httpx.Request) -> httpx.Response:
        if self.down:
            raise httpx.ConnectError("connection refused", request=request)
        path = request.url.path
        self.calls.append(f"{request.method} {path}")
        body = json.loads(request.content or b"{}")
        if path == "/v1/auth/approle/login":
            if (body.get("role_id"), body.get("secret_id")) != (ROLE_ID, ROLE_PROOF):
                return self.reply(400, {"errors": ["invalid role or secret ID"]})
            token = "hvs.approle-" + base64.b16encode(os.urandom(4)).decode()
            self.tokens.add(token)
            return self.reply(200, {"auth": {"client_token": token, "lease_duration": 3600}})
        if request.headers.get("X-Vault-Token") not in self.tokens:
            return self.reply(403, {"errors": ["permission denied"]})
        prefix = f"/v1/{self.mount}"
        if path == f"{prefix}/keys/{self.key}" and request.method == "GET":
            return self.reply(200, {"data": {"type": "aes256-gcm96", "latest_version": len(self.versions)}})
        if path == f"{prefix}/keys/{self.key}/rotate":
            self.versions.append(AESGCM.generate_key(bit_length=256))
            return self.reply(204, {})
        if path == f"{prefix}/encrypt/{self.key}":
            nonce = os.urandom(12)
            sealed = AESGCM(self.versions[-1]).encrypt(nonce, base64.b64decode(body["plaintext"]), None)
            text = f"vault:v{len(self.versions)}:{base64.b64encode(nonce + sealed).decode()}"
            return self.reply(200, {"data": {"ciphertext": text, "key_version": len(self.versions)}})
        if path == f"{prefix}/decrypt/{self.key}":
            _, version, payload = str(body["ciphertext"]).split(":")
            raw = base64.b64decode(payload)
            try:
                opened = AESGCM(self.versions[int(version[1:]) - 1]).decrypt(raw[:12], raw[12:], None)
            except (InvalidTag, IndexError):
                return self.reply(400, {"errors": ["cipher: message authentication failed"]})
            return self.reply(200, {"data": {"plaintext": base64.b64encode(opened).decode()}})
        return self.reply(404, {"errors": [f"no handler for {path}"]})
