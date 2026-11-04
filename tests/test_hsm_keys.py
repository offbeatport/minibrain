import io
import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from minibrain.encryption import envelope, hsm, keys, rekey
from minibrain.encryption.envelope import HEADER, EnvelopeError
from minibrain.registry.files import store_for
from tests.conftest import Harness

LIBRARY = "/opt/hsm/libfake-pkcs11.so"
VALUES = {"encryption": "hsm", "hsm_library": LIBRARY, "hsm_token": "minibrain", "hsm_key": "minibrain-master"}
SOFTHSM = next(
    (
        path
        for path in (
            "/opt/homebrew/lib/softhsm/libsofthsm2.so",
            "/usr/local/lib/softhsm/libsofthsm2.so",
            "/usr/lib/softhsm/libsofthsm2.so",
            "/usr/lib/x86_64-linux-gnu/softhsm/libsofthsm2.so",
        )
        if Path(path).is_file()
    ),
    None,
)


class FakeToken:
    def __init__(self) -> None:
        self.objects: dict[str, dict[int, bytes]] = {}

    def keys(self, label: str) -> dict[int, Any]:
        return dict(self.objects.get(label, {}))

    def generate(self, label: str, version: int) -> Any:
        self.objects.setdefault(label, {})[version] = AESGCM.generate_key(bit_length=256)
        return self.objects[label][version]

    def encrypt(self, key: Any, iv: bytes, aad: bytes, data: bytes) -> bytes:
        return AESGCM(key).encrypt(iv, data, aad)

    def decrypt(self, key: Any, iv: bytes, aad: bytes, data: bytes) -> bytes:
        try:
            return AESGCM(key).decrypt(iv, data, aad)
        except InvalidTag as error:
            raise EnvelopeError("tag mismatch") from error


@pytest.fixture
def token(monkeypatch: pytest.MonkeyPatch) -> Iterator[FakeToken]:
    fake = FakeToken()
    monkeypatch.setitem(hsm.TOKENS, LIBRARY, fake)
    yield fake


def newest(path: Path) -> envelope.Wrapped:
    return envelope.parse_header(path.read_bytes()[:HEADER]).newest.wrapped


def test_the_hsm_wraps_new_files_and_rotates_to_a_new_key_object(harness: Harness, token: FakeToken) -> None:
    store = store_for(harness.settings)
    local = store.put_stream(io.BytesIO(b"before the switch")).id
    saved = harness.client.put("/api/settings/encryption", json={"values": VALUES})
    assert saved.status_code == 200, saved.text
    assert saved.json()["key"] == "minibrain/minibrain-master#1" and list(token.objects["minibrain-master"]) == [1]
    stored = store.put_stream(io.BytesIO(b"under the hsm")).id
    assert (newest(store.path(stored)).provider, newest(store.path(stored)).key) == (
        "hsm",
        "minibrain/minibrain-master#1",
    )
    service = keys.keys_for(harness.settings)
    with harness.sessions() as session:
        _, after, _ = rekey.rotate_key(session, service, "tester")
        session.commit()
        tally = rekey.run_pass(session, store, service, rekey.Plan(rewrap=True))
    assert after == "minibrain/minibrain-master#2" and tally.rewrapped == 2 and tally.older == 0
    for artifact_id, payload in ((local, b"before the switch"), (stored, b"under the hsm")):
        assert newest(store.path(artifact_id)).key == after
        with store.open(artifact_id) as stream:
            assert stream.read() == payload


def test_an_hsm_without_the_key_is_refused_once_the_install_uses_it(harness: Harness, token: FakeToken) -> None:
    assert harness.client.put("/api/settings/encryption", json={"values": VALUES}).status_code == 200
    token.objects.clear()
    keys.keys_for(harness.settings).instances.clear()
    with pytest.raises(Exception, match="no AES key"):
        store_for(harness.settings).put_stream(io.BytesIO(b"x"))


def test_hsm_settings_and_pin_are_required(harness: Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    missing = harness.client.put("/api/settings/encryption", json={"values": {"encryption": "hsm"}})
    assert missing.status_code == 422 and "library path" in missing.text
    monkeypatch.delenv(hsm.PIN_ENV, raising=False)
    no_pin = harness.client.put("/api/settings/encryption", json={"values": VALUES | {"hsm_library": "/nope.so"}})
    assert no_pin.status_code == 422 and hsm.PIN_ENV in no_pin.text


@pytest.fixture
def softhsm(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[str]:
    pkcs11 = pytest.importorskip("PyKCS11")
    if SOFTHSM is None:
        pytest.skip("SoftHSM2 is not installed")
    tokens = tmp_path / "tokens"
    tokens.mkdir()
    config = tmp_path / "softhsm2.conf"
    config.write_text(f"directories.tokendir = {tokens}\nobjectstore.backend = file\nlog.level = ERROR\n")
    monkeypatch.setenv("SOFTHSM2_CONF", str(config))
    library = pkcs11.PyKCS11Lib()
    library.load(SOFTHSM)
    slot = library.getSlotList()[0]
    library.initToken(slot, "87654321", "minibrain")
    session = library.openSession(slot, pkcs11.CKF_SERIAL_SESSION | pkcs11.CKF_RW_SESSION)
    session.login("87654321", user_type=pkcs11.CKU_SO)
    session.initPin("12345678")
    session.logout()
    session.closeSession()
    monkeypatch.setenv(hsm.PIN_ENV, "12345678")
    monkeypatch.setattr(hsm, "OPEN", {})
    yield SOFTHSM


def test_softhsm_wraps_unwraps_and_rotates(harness: Harness, softhsm: str) -> None:
    values = VALUES | {"hsm_library": softhsm}
    saved = harness.client.put("/api/settings/encryption", json={"values": values})
    assert saved.status_code == 200, saved.text
    store = store_for(harness.settings)
    payload = os.urandom(2 * (1 << 20) + 3)
    stored = store.put_stream(io.BytesIO(payload)).id
    wrapped = newest(store.path(stored))
    assert (wrapped.provider, wrapped.key) == ("hsm", "minibrain/minibrain-master#1")
    with store.open(stored) as stream:
        assert stream.read() == payload
    service = keys.keys_for(harness.settings)
    with harness.sessions() as session:
        _, after, _ = rekey.rotate_key(session, service, "tester")
        session.commit()
        tally = rekey.run_pass(session, store, service, rekey.Plan(rewrap=True))
    assert after.endswith("#2") and tally.rewrapped == 1
    with store.open(stored) as stream:
        assert stream.read() == payload
    provider = service.target()
    other = provider.wrap(envelope.new_key(), b"minibrain.artifact.one")
    with pytest.raises(EnvelopeError):
        provider.unwrap(other, b"minibrain.artifact.two")
