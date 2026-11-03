import json
import logging
import stat
from collections.abc import Iterator
from pathlib import Path

import pytest
import yaml
from sqlalchemy import select

from minibrain.connections import vault
from minibrain.connections.store import context
from minibrain.registry.models import AuditEvent, Connection
from minibrain.settings import Settings
from tests.conftest import Harness

PASSWORD = "pg-password-never-shown-1234"
SECRET = "s3-secret-never-shown-5678"
POSTGRES = {
    "name": "Warehouse",
    "kind": "postgres",
    "host": "db.internal",
    "port": 5432,
    "database": "analytics",
    "user": "minibrain_ro",
    "ssl_mode": "require",
    "secret": PASSWORD,
}
S3 = {
    "name": "Model bucket",
    "kind": "s3",
    "endpoint": "https://minio.internal:9000",
    "bucket": "models",
    "access_key": "AKIAEXAMPLE",
    "path_style": True,
    "secret": SECRET,
}


@pytest.fixture
def config_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    path = tmp_path / "minibrain.yaml"
    monkeypatch.setenv("MINIBRAIN_CONFIG", str(path))
    yield path


def created(harness: Harness, body: dict) -> dict:
    response = harness.client.post("/api/connections", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def stored(harness: Harness, connection_id: int) -> Connection:
    with harness.sessions() as session:
        found = session.get(Connection, connection_id)
        assert found is not None
        session.expunge(found)
        return found


def everything_said(harness: Harness) -> str:
    with harness.sessions() as session:
        audit = [event.detail | {"action": event.action} for event in session.scalars(select(AuditEvent))]
    return json.dumps([harness.client.get("/api/connections").json(), harness.client.get("/api/sources").json(), audit])


def test_secrets_round_trip_under_the_master_key(settings: Settings) -> None:
    settings.home.mkdir(parents=True)
    sealed = vault.seal(settings, PASSWORD, "minibrain.connection.1")
    assert PASSWORD not in sealed and sealed.startswith(f"{vault.FORMAT}:")
    assert vault.unseal(settings, sealed, "minibrain.connection.1") == PASSWORD
    assert vault.seal(settings, PASSWORD, "minibrain.connection.1") != sealed
    key = vault.key_path(settings)
    assert stat.S_IMODE(key.stat().st_mode) == 0o600
    with pytest.raises(vault.VaultError):
        vault.unseal(settings, sealed, "minibrain.connection.2")
    tampered = sealed[:-4] + ("AAAA" if not sealed.endswith("AAAA") else "BBBB")
    with pytest.raises(vault.VaultError):
        vault.unseal(settings, tampered, "minibrain.connection.1")
    key.write_text("bm90IGEga2V5")
    with pytest.raises(vault.VaultError, match="256-bit"):
        vault.unseal(settings, sealed, "minibrain.connection.1")


def test_master_key_can_come_from_a_mounted_file(
    settings: Settings, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mounted = tmp_path / "run" / "master.key"
    monkeypatch.setenv(vault.KEY_ENV, str(mounted))
    with pytest.raises(vault.VaultError, match="does not exist"):
        vault.seal(settings, PASSWORD, "x")
    vault.create_key(mounted)
    sealed = vault.seal(settings, PASSWORD, "x")
    assert vault.unseal(settings, sealed, "x") == PASSWORD
    assert not (settings.home / "secrets" / vault.KEY_FILE).exists()


def test_secrets_are_write_only_and_replaceable(harness: Harness, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    connection = created(harness, POSTGRES)
    assert PASSWORD not in json.dumps(connection)
    assert (connection["secret_set"], connection["locked"], connection["secret_source"]) == (True, False, None)
    assert connection["summary"] == "minibrain_ro@db.internal:5432/analytics"
    row = stored(harness, connection["id"])
    assert row.secret is not None and PASSWORD not in row.secret and PASSWORD not in json.dumps(row.config)
    assert vault.unseal(harness.settings, row.secret, context(row)) == PASSWORD
    kept = harness.client.put(f"/api/connections/{connection['id']}", json=POSTGRES | {"secret": None, "port": 6432})
    assert kept.status_code == 200, kept.text
    assert stored(harness, connection["id"]).secret == row.secret
    replaced = harness.client.put(f"/api/connections/{connection['id']}", json=POSTGRES | {"secret": "new-password-9"})
    assert replaced.json()["secret_set"] is True
    fresh = stored(harness, connection["id"])
    assert vault.unseal(harness.settings, fresh.secret or "", context(fresh)) == "new-password-9"
    said = everything_said(harness)
    assert PASSWORD not in said and "new-password-9" not in said
    assert PASSWORD not in caplog.text and "new-password-9" not in caplog.text
    with harness.sessions() as session:
        actions = [(event.action, event.detail.get("secret")) for event in session.scalars(select(AuditEvent))]
    assert actions == [("connection.create", None), ("connection.update", "kept"), ("connection.update", "replaced")]
    assert harness.client.delete(f"/api/connections/{connection['id']}").status_code == 204
    assert harness.client.get("/api/connections").json() == []


def test_connections_are_checked_before_they_are_saved(harness: Harness) -> None:
    missing = harness.client.post("/api/connections", json=POSTGRES | {"secret": None})
    assert missing.status_code == 422 and "password" in missing.json()["detail"]
    with_port = harness.client.post("/api/connections", json=POSTGRES | {"host": "db.internal:5432"})
    assert with_port.status_code == 422 and "port has its own field" in with_port.json()["detail"]
    bad_ssl = harness.client.post("/api/connections", json=POSTGRES | {"ssl_mode": "sometimes"})
    assert bad_ssl.status_code == 422 and "SSL mode" in bad_ssl.json()["detail"]
    bad_endpoint = harness.client.post("/api/connections", json=S3 | {"endpoint": "minio.internal"})
    assert bad_endpoint.status_code == 422 and "https://" in bad_endpoint.json()["detail"]
    created(harness, POSTGRES)
    again = harness.client.post("/api/connections", json=POSTGRES | {"name": "warehouse"})
    assert again.status_code == 409


def test_endpoints_must_pass_the_network_policy(harness: Harness) -> None:
    assert harness.client.put("/api/policies/network", json={"value": "allowlist"}).status_code == 200
    harness.client.put("/api/policies/allowed_hosts", json={"value": ["minio.internal"]})
    refused = harness.client.post("/api/connections", json=POSTGRES)
    assert refused.status_code == 403
    assert "db.internal is not on it" in refused.json()["detail"] and "Allowed hosts" in refused.json()["detail"]
    bucket = created(harness, S3)
    assert bucket["problem"] is None
    tested = harness.client.post("/api/connections/test", json=POSTGRES).json()
    assert tested["ok"] is False and "db.internal" in tested["message"]
    harness.client.put("/api/policies/network", json={"value": "offline"})
    listed = harness.client.get("/api/connections").json()[0]
    assert "Offline" in listed["problem"]
    saved = harness.client.post(f"/api/connections/{bucket['id']}/test").json()
    assert saved["ok"] is False and "Offline" in saved["message"]


def write_config(path: Path, connections: list[dict]) -> None:
    path.write_text(yaml.safe_dump({"connections": connections}))


def test_config_connections_resolve_references_and_are_locked(
    harness: Harness, config_file: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    secret_file = tmp_path / "run" / "s3_key"
    secret_file.parent.mkdir()
    secret_file.write_text(SECRET + "\n")
    monkeypatch.setenv("WAREHOUSE_PASSWORD", PASSWORD)
    declared_pg = {key: value for key, value in POSTGRES.items() if key != "secret"} | {
        "secret_env": "WAREHOUSE_PASSWORD"
    }
    declared_s3 = {key: value for key, value in S3.items() if key != "secret"} | {"secret_file": str(secret_file)}
    write_config(config_file, [declared_pg, declared_s3])
    listed = {item["name"]: item for item in harness.client.get("/api/connections").json()}
    assert listed["Warehouse"]["locked"] is True and listed["Warehouse"]["secret_set"] is True
    assert listed["Warehouse"]["secret_source"] == "environment variable WAREHOUSE_PASSWORD"
    assert listed["Model bucket"]["secret_source"] == f"file {secret_file}"
    assert listed["Model bucket"]["problem"] is None
    from minibrain.connections.store import resolve

    with harness.sessions() as session:
        rows = {row.name: row for row in session.scalars(select(Connection))}
        assert all(row.secret is None for row in rows.values())
        assert resolve(session, harness.settings, rows["Warehouse"]).secret == PASSWORD
        assert resolve(session, harness.settings, rows["Model bucket"]).secret == SECRET
    warehouse = listed["Warehouse"]["id"]
    changed = harness.client.put(f"/api/connections/{warehouse}", json=POSTGRES)
    assert changed.status_code == 409 and "minibrain.yaml" in changed.json()["detail"]
    assert harness.client.delete(f"/api/connections/{warehouse}").status_code == 409
    monkeypatch.delenv("WAREHOUSE_PASSWORD")
    secret_file.unlink()
    gone = {item["name"]: item for item in harness.client.get("/api/connections").json()}
    assert gone["Warehouse"]["secret_set"] is False
    assert "secret not found" in gone["Warehouse"]["problem"] and "WAREHOUSE_PASSWORD" in gone["Warehouse"]["problem"]
    assert "secret not found" in gone["Model bucket"]["problem"]
    assert PASSWORD not in everything_said(harness) and SECRET not in everything_said(harness)
    write_config(config_file, [declared_s3])
    assert [item["name"] for item in harness.client.get("/api/connections").json()] == ["Model bucket"]


def test_config_never_takes_plaintext_secrets(harness: Harness, config_file: Path) -> None:
    plain = {key: value for key, value in POSTGRES.items() if key != "secret"} | {"password": PASSWORD}
    write_config(config_file, [plain])
    listed = harness.client.get("/api/connections").json()
    assert listed[0]["locked"] is True
    assert "plain text" in listed[0]["problem"] and "secret_env" in listed[0]["problem"]
    assert PASSWORD not in everything_said(harness)
    with harness.sessions() as session:
        row = session.scalars(select(Connection)).one()
        assert PASSWORD not in json.dumps(row.config) and row.secret is None
