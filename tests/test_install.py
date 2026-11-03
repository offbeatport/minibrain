import io
import logging
import platform
import zipfile
from pathlib import Path

import pytest

from minibrain.api.install import git_commit
from minibrain.object_store import secret_path
from tests.conftest import Harness

HUB_VALUE = "hf_diagnosticsSecretValue42"
BUCKET_VALUE = "s3-diagnostics-secret-key-0042"
DATABASE_VALUE = "pg-password-never-shown"


def test_install_overview_reports_versions_places_and_network(harness: Harness) -> None:
    assert harness.client.put("/api/policies/network", json={"value": "allowlist"}).status_code == 200
    assert harness.client.put("/api/policies/allowed_hosts", json={"value": "huggingface.co"}).status_code == 200
    found = harness.client.get("/api/system/install").json()
    software = found["software"]
    assert software["python"] == platform.python_version() and software["duckdb"] and software["arch"]
    places = found["places"]
    assert places["home"] == str(harness.settings.home)
    assert places["database_kind"] == "sqlite" and places["database_bytes"] > 0
    assert (places["storage_kind"], places["storage_bucket"]) == ("local", None)
    assert found["catalogue"]["bundled_snapshot"] and found["catalogue"]["entries"] > 0
    assert found["compute"]["pools"] >= 1 and found["compute"]["machines_online"] >= 1
    network = found["network"]
    assert (network["mode"], network["allowed_hosts"], network["locked"]) == ("allowlist", ["huggingface.co"], False)
    allowed = {item["name"]: item["allowed"] for item in network["endpoints"]}
    assert allowed["Hugging Face"] is True and allowed["Model imports from S3"] is False


def test_offline_blocks_every_governed_endpoint(harness: Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MINIBRAIN_OFFLINE", "1")
    network = harness.client.get("/api/system/install").json()["network"]
    assert (network["mode"], network["locked"], network["source"]) == ("offline", True, "environment")
    assert not any(item["allowed"] for item in network["endpoints"] if item["by_policy"])


def test_git_commit_reads_loose_and_packed_refs(tmp_path: Path) -> None:
    git = tmp_path / ".git"
    (git / "refs" / "heads").mkdir(parents=True)
    (git / "HEAD").write_text("ref: refs/heads/main\n")
    (git / "packed-refs").write_text("# pack-refs\nabc123 refs/heads/main\n")
    assert git_commit(git) == "abc123"
    (git / "refs" / "heads" / "main").write_text("def456\n")
    assert git_commit(git) == "def456"
    (git / "HEAD").write_text("0123456789\n")
    assert git_commit(git) == "0123456789"
    assert git_commit(tmp_path / "missing") is None


def diagnostics(harness: Harness) -> dict[str, str]:
    response = harness.client.get("/api/system/diagnostics")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
    assert response.headers["content-disposition"].startswith('attachment; filename="minibrain-diagnostics-')
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        return {Path(name).name: archive.read(name).decode() for name in archive.namelist()}


def test_diagnostics_zip_never_contains_secrets(harness: Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HF_TOKEN", HUB_VALUE)
    monkeypatch.setenv("MINIBRAIN_DATABASE_PASSWORD", DATABASE_VALUE)
    secret_path(harness.settings).parent.mkdir(parents=True, exist_ok=True)
    secret_path(harness.settings).write_text(BUCKET_VALUE)
    secrets = [
        HUB_VALUE,
        BUCKET_VALUE,
        DATABASE_VALUE,
        harness.settings.secret("worker_token"),
        harness.settings.secret("gateway_token"),
    ]
    logging.getLogger("minibrain.test").warning("worker sent %s and %s", secrets[3], HUB_VALUE)
    files = diagnostics(harness)
    assert set(files) == {"install.json", "machine.json", "settings.json", "policies.json", "jobs.json", "server.log"}
    assert '"python"' in files["install.json"] and '"network"' in files["policies.json"]
    assert '"token_set": true' in files["settings.json"] and "HF_TOKEN" in files["settings.json"]
    assert "worker sent [redacted] and [redacted]" in files["server.log"]
    for text in files.values():
        for secret in secrets:
            assert secret not in text
