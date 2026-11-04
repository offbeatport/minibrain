import io
from collections.abc import Iterator
from typing import Any

import pytest
from botocore.session import get_session
from moto import mock_aws

from minibrain.encryption import envelope, keys, kms, rekey
from minibrain.encryption.envelope import HEADER, EnvelopeError
from minibrain.registry.files import store_for
from tests.conftest import Harness

REGION = "eu-west-1"


@pytest.fixture
def aws(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    for name, value in {
        "AWS_ACCESS_KEY_ID": "testing",
        "AWS_SECRET_ACCESS_KEY": "testing",
        "AWS_SESSION_TOKEN": "testing",
        "AWS_DEFAULT_REGION": REGION,
    }.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("AWS_PROFILE", raising=False)
    with mock_aws():
        yield get_session().create_client("kms", region_name=REGION)


def newest(path) -> envelope.Wrapped:
    return envelope.parse_header(path.read_bytes()[:HEADER]).newest.wrapped


def switch(harness: Harness, values: dict) -> dict:
    saved = harness.client.put("/api/settings/encryption", json={"values": values})
    assert saved.status_code == 200, saved.text
    return saved.json()


def test_kms_wraps_files_and_a_new_key_arn_moves_them(harness: Harness, aws: Any) -> None:
    first = aws.create_key(Description="minibrain")["KeyMetadata"]["Arn"]
    second = aws.create_key(Description="minibrain next")["KeyMetadata"]["Arn"]
    store = store_for(harness.settings)
    local = store.put_stream(io.BytesIO(b"before kms")).id
    assert switch(harness, {"encryption": "kms", "kms_key": first})["key"] == first
    stored = store.put_stream(io.BytesIO(b"under kms")).id
    assert (newest(store.path(stored)).provider, newest(store.path(stored)).key) == ("kms", first)
    with store.open(stored) as stream:
        assert stream.read() == b"under kms"
    switch(harness, {"kms_key": second})
    service = keys.keys_for(harness.settings)
    with harness.sessions() as session:
        before, after, note = rekey.rotate_key(session, service, "tester")
        session.commit()
        tally = rekey.run_pass(session, store, service, rekey.Plan(rewrap=True))
    assert before == after == second and "rotates a key's material itself" in note
    assert tally.rewrapped == 2 and tally.older == 0
    for artifact_id, payload in ((local, b"before kms"), (stored, b"under kms")):
        assert newest(store.path(artifact_id)).key == second
        with store.open(artifact_id) as stream:
            assert stream.read() == payload


def test_the_encryption_context_binds_each_data_key_to_its_file(harness: Harness, aws: Any) -> None:
    arn = aws.create_key()["KeyMetadata"]["Arn"]
    switch(harness, {"encryption": "kms", "kms_key": arn})
    provider = keys.keys_for(harness.settings).target()
    wrapped = provider.wrap(envelope.new_key(), b"minibrain.artifact.one")
    with pytest.raises(EnvelopeError):
        provider.unwrap(wrapped, b"minibrain.artifact.two")


def test_a_disabled_or_missing_key_is_refused(harness: Harness, aws: Any) -> None:
    metadata = aws.create_key()["KeyMetadata"]
    arn = metadata["Arn"]
    aws.disable_key(KeyId=metadata["KeyId"])
    refused = harness.client.put("/api/settings/encryption", json={"values": {"encryption": "kms", "kms_key": arn}})
    assert refused.status_code == 422 and "Disabled" in refused.text
    missing = harness.client.put(
        "/api/settings/encryption",
        json={"values": {"encryption": "kms", "kms_key": f"arn:aws:kms:{REGION}:123456789012:key/nope"}},
    )
    assert missing.status_code == 422
    assert harness.client.get("/api/settings/encryption").json()["provider"] == "local"


def test_fips_endpoints_and_regions_come_from_the_settings() -> None:
    config = kms.config_from({"kms_key": "arn:aws:kms:us-gov-west-1:123456789012:key/abc", "kms_fips": True})
    assert config.region == "us-gov-west-1"
    assert kms.make_client(config).meta.endpoint_url == "https://kms-fips.us-gov-west-1.amazonaws.com"
    plain = kms.config_from({"kms_key": "alias/minibrain", "kms_region": "eu-west-1"})
    assert kms.make_client(plain).meta.endpoint_url == "https://kms.eu-west-1.amazonaws.com"
    with pytest.raises(Exception, match="region"):
        kms.config_from({"kms_key": "alias/minibrain"})
    with pytest.raises(Exception, match="https"):
        kms.config_from({"kms_key": "alias/minibrain", "kms_region": "eu-west-1", "kms_endpoint": "http://x"})
