from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
import yaml
from fastapi.testclient import TestClient

from minibrain.app import create_app
from minibrain.auth.config import load_auth
from minibrain.auth.first_run import setup_open
from minibrain.config_export import export, render
from minibrain.data.limits import load_limits
from minibrain.object_store import load_config, read_secret
from minibrain.policy import locked_sources
from minibrain.provision import ConfigError, problems
from minibrain.registry.prices import load_prices
from minibrain.settings import Settings
from tests.conftest import FakeBackend, Harness, sign_in
from tests.test_proxy import PROXY, as_person, proxied_install

STORAGE = {
    "kind": "s3",
    "endpoint": "https://minio.internal:9000",
    "bucket": "ml-artifacts",
    "prefix": "team-a",
    "access_key": "AKIAEXAMPLE",
}


@pytest.fixture
def config_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    path = tmp_path / "minibrain.yaml"
    monkeypatch.setenv("MINIBRAIN_CONFIG", str(path))
    yield path


def write(path: Path, found: dict[str, Any]) -> None:
    path.write_text(yaml.safe_dump(found))


def test_settings_from_the_file_are_used_and_locked(
    harness: Harness, config_file: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    secret = tmp_path / "s3-secret"
    secret.write_text("from-a-file\n")
    write(
        config_file,
        {
            "storage": STORAGE | {"secret_file": str(secret)},
            "data": {"row_limit": 5000, "checks_off": ["personal_data"]},
            "compute": {"currency": "EUR", "prices": {"local": 2.5}},
            "catalogue": {"daily_sync": True},
        },
    )
    assert problems() == []
    client = harness.client
    storage = client.get("/api/settings/storage").json()
    assert (storage["kind"], storage["bucket"], storage["prefix"], storage["locked"]) == (
        "s3",
        "ml-artifacts",
        "team-a",
        "config file",
    )
    assert storage["secret_set"] is True and storage["secret_reference"] == f"the file {secret}"
    assert read_secret(harness.settings) == "from-a-file"
    assert client.put("/api/settings/storage", json={"kind": "local"}).status_code == 409
    data = client.get("/api/settings/data").json()
    assert (data["row_limit"], data["checks_off"]) == (5000, ["personal_data"])
    assert data["locked"] == {"row_limit": "config file", "checks_off": "config file"}
    assert client.put("/api/settings/data", json={"row_limit": 9000}).status_code == 409
    assert client.put("/api/settings/data", json={"keep_versions": 7}).status_code == 200
    prices = client.get("/api/compute/prices").json()
    assert (prices["currency"], prices["currency_locked"]) == ("EUR", "config file")
    assert [(pool["hourly_price"], pool["locked"]) for pool in prices["pools"] if pool["pool"] == "local"] == [
        (2.5, "config file")
    ]
    assert client.put("/api/compute/prices", json={"currency": "USD"}).status_code == 409
    assert client.put("/api/compute/prices", json={"hourly": {"local": 9.0}}).status_code == 409
    catalogue = client.get("/api/catalog/settings").json()
    assert catalogue == {"daily_sync": True, "daily_sync_locked": "config file"}
    assert client.put("/api/catalog/settings", json={"daily_sync": False}).status_code == 409
    config_file.unlink()
    with harness.sessions() as session:
        assert load_limits(session).row_limit == 200_000 and load_limits(session).keep_versions == 7
        assert load_prices(session).currency == "USD" and load_config(session).kind == "local"


def test_the_environment_locks_settings_and_names_its_variable(
    harness: Harness, config_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MINIBRAIN_DATA_ROW_LIMIT", "1500")
    monkeypatch.setenv("MINIBRAIN_CATALOGUE_DAILY_SYNC", "true")
    assert harness.client.get("/api/settings/data").json()["locked"] == {"row_limit": "environment"}
    assert harness.client.get("/api/catalog/settings").json()["daily_sync_locked"] == "environment"
    monkeypatch.setenv("MINIBRAIN_DATA_ROW_LIMIT", "12")
    with pytest.raises(ConfigError, match="MINIBRAIN_DATA_ROW_LIMIT"):
        problems()


def test_secrets_in_the_file_are_refused_with_the_key(config_file: Path) -> None:
    write(config_file, {"storage": STORAGE | {"secret": "inline"}})
    with pytest.raises(ConfigError, match=r"storage\.secret: minibrain.yaml never holds secrets"):
        problems()
    write(config_file, {"storage": STORAGE | {"password": "inline"}})
    with pytest.raises(ConfigError, match=r"storage\.password"):
        problems()
    write(config_file, {"policy": {"otel_headers": "Authorization=Bearer inline"}})
    with pytest.raises(ConfigError, match=r"policy\.otel_headers: minibrain.yaml never holds secrets"):
        problems()
    oidc = {"issuer": "https://idp.example.test/realms/corp", "client_id": "minibrain", "client_secret": "inline"}
    write(config_file, {"auth": {"oidc": oidc}})
    with pytest.raises(ConfigError, match=r"auth\.oidc\.client_secret writes the secret into minibrain.yaml"):
        problems()


def test_collector_headers_come_from_a_named_variable_or_file(
    config_file: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write(config_file, {"policy": {"otel_headers": {"secret_env": "COLLECTOR_HEADERS"}}})
    with pytest.raises(ConfigError, match="Collector headers not found in the environment variable COLLECTOR_HEADERS"):
        problems()
    monkeypatch.setenv("COLLECTOR_HEADERS", "Authorization=Bearer t0ken")
    assert problems() == []
    assert locked_sources()["otel_headers"] == (
        "config file",
        {"names": ["Authorization"], "plain": "Authorization=Bearer t0ken"},
    )
    headers = tmp_path / "otel-headers"
    headers.write_text("X-Tenant=acme\n")
    write(config_file, {"policy": {"otel_headers": {"secret_file": str(headers)}}})
    assert locked_sources()["otel_headers"][1]["names"] == ["X-Tenant"]


@pytest.mark.parametrize(
    ("found", "message"),
    [
        ({"data": {"row_limit": 5}}, r"data\.row_limit: Input should be greater than or equal to 100"),
        ({"storage": {"kind": "ftp"}}, r"storage\.kind"),
        ({"storage": {"kind": "s3", "bucket": "b"}}, "storage also needs endpoint, access_key"),
        ({"compute": {"currency": "euro"}}, r"compute\.currency"),
        ({"compute": {"prices": {"local": -1}}}, r"compute\.prices\.local"),
        ({"policy": {"network": "sideways"}}, r"policy\.network: Network must be one of"),
        ({"auth": {"admins": "ada"}}, "auth.admins is a list"),
        ({"storage": ["kind"]}, "storage in minibrain.yaml must be a mapping"),
    ],
)
def test_bad_values_stop_the_start_naming_the_key(
    config_file: Path, settings: Settings, found: dict[str, Any], message: str
) -> None:
    write(config_file, found)
    with pytest.raises(ConfigError, match=message):
        problems()
    settings.home.mkdir(parents=True)
    with pytest.raises(ConfigError, match=message):
        create_app(settings=settings, backend=FakeBackend(), background=False)


def test_unknown_keys_warn_and_are_ignored(config_file: Path, caplog: pytest.LogCaptureFixture) -> None:
    write(
        config_file,
        {"colour": "blue", "data": {"row_limit": 1000, "rows": 3}, "policy": {"speed": 1}, "auth": {"teams": {}}},
    )
    assert problems() == [
        "minibrain.yaml: unknown section colour, ignored",
        "minibrain.yaml: unknown setting data.rows, ignored",
        "minibrain.yaml: unknown policy speed, ignored",
        "minibrain.yaml: unknown setting auth.teams, ignored",
    ]
    config_file.write_text("data: [unclosed")
    with pytest.raises(ConfigError, match="not valid YAML"):
        problems()


def test_admins_from_the_file_need_no_setup_link(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    auth = {"proxy": {"addresses": ["10.0.0.0/30"]}, "admins": ["Ada@Example.com", "grace"]}
    for proxied in proxied_install(settings, monkeypatch, auth):
        with proxied.app.state.sessions() as session:
            assert setup_open(session, load_auth()) is False
        client = proxied.client(PROXY)
        assert client.get("/api/auth/session").json()["setup"] is False
        ada = client.get("/api/auth/session", headers=as_person("ada", "ada@example.com")).json()["person"]
        grace = client.get("/api/auth/session", headers=as_person("grace")).json()["person"]
        other = client.get("/api/auth/session", headers=as_person("linus", "linus@example.com")).json()["person"]
        assert (ada["role"], ada["role_locked"], grace["role"], other["role"]) == ("admin", True, "admin", None)
        people = client.get("/api/accounts", headers=as_person("grace")).json()["people"]
        assert {person["name"]: person["admin_listed"] for person in people} == {
            "ada": True,
            "grace": True,
            "linus": False,
        }
        listed = next(person for person in people if person["name"] == "ada")
        token = client.get("/api/auth/session", headers=as_person("grace")).json()["csrf_token"]
        headers = as_person("grace") | {"X-CSRF-Token": token}
        changed = client.patch(f"/api/accounts/{listed['id']}", json={"role": "viewer"}, headers=headers)
        assert changed.status_code == 422 and "auth.admins" in changed.text


def test_admins_without_single_sign_on_keep_the_setup_link(
    config_file: Path, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    write(config_file, {"auth": {"admins": ["ada@example.com"]}})
    assert any("auth.admins applies to people who sign in" in warning for warning in problems())
    settings.home.mkdir(parents=True)
    app = create_app(settings=settings, backend=FakeBackend(), background=False)
    with app.state.sessions() as session:
        assert setup_open(session, load_auth()) is True


def provision_everything(harness: Harness, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = harness.client
    assert client.put("/api/policies/network", json={"value": "allowlist"}).status_code == 200
    assert client.put("/api/policies/allowed_hosts", json={"value": "minio.internal, db.internal"}).status_code == 200
    assert client.put("/api/policies/log_retention_days", json={"value": 14}).status_code == 200
    assert client.put("/api/settings/data", json={"row_limit": 4000, "checks_off": ["leakage"]}).status_code == 200
    assert client.put("/api/compute/prices", json={"currency": "GBP", "hourly": {"local": 1.25}}).status_code == 200
    assert client.put("/api/catalog/settings", json={"daily_sync": True}).status_code == 200
    body = {
        "name": "Warehouse",
        "kind": "postgres",
        "host": "db.internal",
        "port": 5432,
        "database": "analytics",
        "user": "reader",
        "ssl_mode": "verify-full",
        "secret": "pg-password",
    }
    assert client.post("/api/connections", json=body).status_code == 201


def test_config_export_round_trips_without_secrets(
    harness: Harness, config_file: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    provision_everything(harness, tmp_path, monkeypatch)
    with harness.sessions() as session:
        text = render(*export(session, harness.settings))
    assert "pg-password" not in text
    found = yaml.safe_load(text)
    assert found["policy"]["network"] == "allowlist" and found["policy"]["log_retention_days"] == 14
    assert found["data"]["row_limit"] == 4000 and found["compute"] == {"currency": "GBP", "prices": {"local": 1.25}}
    assert found["connections"] == [
        {
            "name": "Warehouse",
            "kind": "postgres",
            "host": "db.internal",
            "port": 5432,
            "database": "analytics",
            "user": "reader",
            "ssl_mode": "verify-full",
            "secret_env": "MINIBRAIN_CONNECTION_WAREHOUSE",
        }
    ]
    assert "#   connection Warehouse: set MINIBRAIN_CONNECTION_WAREHOUSE to its secret" in text
    config_file.write_text(text)
    assert problems() == []
    monkeypatch.setenv("MINIBRAIN_CONNECTION_WAREHOUSE", "pg-password")
    with harness.sessions() as session:
        again = render(*export(session, harness.settings))
        assert load_limits(session).checks_off == ("leakage",)
    assert yaml.safe_load(again) == found
    listed = harness.client.get("/api/connections").json()
    assert [(item["name"], item["locked"], item["id"]) for item in listed] == [("Warehouse", True, 1)]
    assert harness.client.put("/api/policies/network", json={"value": "open"}).status_code == 409


def test_export_names_the_storage_secret_file(harness: Harness, config_file: Path, tmp_path: Path) -> None:
    secret = tmp_path / "s3-secret"
    secret.write_text("abc")
    write(config_file, {"storage": STORAGE | {"secret_file": str(secret)}})
    with harness.sessions() as session:
        found, notes = export(session, harness.settings)
    assert found["storage"] == STORAGE | {"secret_file": str(secret)}
    assert "abc" not in render(found, notes)


def test_a_signed_in_admin_sees_file_admins_flagged(harness: Harness) -> None:
    people = sign_in(harness.app, TestClient(harness.app)).get("/api/accounts").json()["people"]
    assert all(person["admin_listed"] is False for person in people)
