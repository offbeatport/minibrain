import io
from collections.abc import Iterator

import pytest

from minibrain.encryption import envelope, keys, rekey, vault_transit
from minibrain.encryption.envelope import HEADER
from minibrain.registry.files import store_for
from tests.conftest import Harness
from tests.fake_vault import ROLE_ID, ROLE_PROOF, ROOT, FakeVault

ADDRESS = "https://vault.internal:8200"
VAULT = {"encryption": "vault", "vault_address": ADDRESS}


@pytest.fixture
def vault(monkeypatch: pytest.MonkeyPatch) -> Iterator[FakeVault]:
    fake = FakeVault()
    monkeypatch.setitem(vault_transit.TRANSPORTS, ADDRESS, fake.transport())
    monkeypatch.setenv(vault_transit.SIGN_IN_ENV, ROOT)
    yield fake


def switch(harness: Harness, values: dict) -> dict:
    response = harness.client.put("/api/settings/encryption", json={"values": values})
    assert response.status_code == 200, response.text
    return response.json()


def newest(path) -> envelope.Wrapped:
    return envelope.parse_header(path.read_bytes()[:HEADER]).newest.wrapped


def test_files_are_wrapped_by_vault_transit_after_a_tested_switch(harness: Harness, vault: FakeVault) -> None:
    store = store_for(harness.settings)
    before = store.put_stream(io.BytesIO(b"sealed under the local key")).id
    checked = harness.client.post("/api/settings/encryption/test", json={"values": VAULT}).json()
    assert checked["ok"] is True and "transit/minibrain:v1" in checked["message"]
    assert harness.client.get("/api/settings/encryption").json()["provider"] == "local"
    status = switch(harness, VAULT)
    assert (status["provider"], status["key"]) == ("vault", "transit/minibrain:v1")
    after = store.put_stream(io.BytesIO(b"sealed under vault")).id
    wrapped = newest(store.path(after))
    assert (wrapped.provider, wrapped.key) == ("vault", "transit/minibrain:v1")
    assert wrapped.blob.startswith(b"vault:v1:")
    with store.open(after) as stream:
        assert stream.read() == b"sealed under vault"
    with store.open(before) as stream:
        assert stream.read() == b"sealed under the local key"
    assert any(call.endswith("/v1/transit/encrypt/minibrain") for call in vault.calls)


def test_a_switch_that_cannot_reach_vault_is_refused(harness: Harness, vault: FakeVault) -> None:
    vault.down = True
    refused = harness.client.put("/api/settings/encryption", json={"values": VAULT})
    assert refused.status_code in (422, 503) and "unreachable" in refused.text
    assert harness.client.get("/api/settings/encryption").json()["provider"] == "local"
    checked = harness.client.post("/api/settings/encryption/test", json={"values": VAULT}).json()
    assert checked["ok"] is False and "unreachable" in checked["message"]


def test_rotation_moves_every_file_to_the_new_transit_version(harness: Harness, vault: FakeVault) -> None:
    store = store_for(harness.settings)
    old = store.put_stream(io.BytesIO(b"local first")).id
    switch(harness, VAULT)
    under_vault = store.put_stream(io.BytesIO(b"vault next")).id
    service = keys.keys_for(harness.settings)
    with harness.sessions() as session:
        before, after, _ = rekey.rotate_key(session, service, "tester")
        session.commit()
        tally = rekey.run_pass(session, store, service, rekey.Plan(rewrap=True))
        session.commit()
    assert (before, after) == ("transit/minibrain:v1", "transit/minibrain:v2")
    assert tally.rewrapped == 2 and tally.older == 0
    for artifact_id in (old, under_vault):
        wrapped = newest(store.path(artifact_id))
        assert (wrapped.provider, wrapped.key) == ("vault", after) and wrapped.blob.startswith(b"vault:v2:")
    with store.open(old) as stream:
        assert stream.read() == b"local first"


def test_a_data_key_from_another_file_is_refused(harness: Harness, vault: FakeVault) -> None:
    switch(harness, VAULT)
    provider = keys.keys_for(harness.settings).target()
    wrapped = provider.wrap(envelope.new_key(), b"minibrain.artifact.one")
    with pytest.raises(envelope.EnvelopeError, match="another file"):
        provider.unwrap(wrapped, b"minibrain.artifact.two")


def test_approle_signs_in_and_reuses_its_token(
    harness: Harness, vault: FakeVault, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv(vault_transit.SIGN_IN_ENV)
    monkeypatch.setenv(vault_transit.APPROLE_ENV, ROLE_PROOF)
    switch(harness, VAULT | {"vault_auth": "approle", "vault_role_id": ROLE_ID})
    store = store_for(harness.settings)
    for index in range(3):
        stored = store.put_stream(io.BytesIO(f"row {index}".encode())).id
        with store.open(stored) as stream:
            assert stream.read() == f"row {index}".encode()
    logins = [call for call in vault.calls if call.endswith("/auth/approle/login")]
    assert len(logins) <= 2


def test_vault_settings_are_checked(harness: Harness, vault: FakeVault) -> None:
    refused = harness.client.put(
        "/api/settings/encryption", json={"values": {"encryption": "vault", "vault_address": "vault.internal"}}
    )
    assert refused.status_code in (422, 503) and "https://" in refused.text
    no_role = harness.client.put("/api/settings/encryption", json={"values": VAULT | {"vault_auth": "approle"}})
    assert no_role.status_code in (422, 503) and "role ID" in no_role.text
    other = harness.client.put("/api/settings/encryption", json={"values": {"request_bodies": True}})
    assert other.status_code == 403


def test_the_policy_list_also_tests_a_new_provider_before_saving(harness: Harness, vault: FakeVault) -> None:
    vault.down = True
    assert harness.client.put("/api/policies/vault_address", json={"value": ADDRESS}).status_code == 200
    refused = harness.client.put("/api/policies/encryption", json={"value": "vault"})
    assert refused.status_code in (422, 503) and "unreachable" in refused.text
    assert harness.client.get("/api/settings/encryption").json()["provider"] == "local"
    vault.down = False
    assert harness.client.put("/api/policies/encryption", json={"value": "vault"}).status_code == 200
    assert harness.client.get("/api/settings/encryption").json()["key"] == "transit/minibrain:v1"
