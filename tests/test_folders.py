import os
from pathlib import Path

import pytest

from tests.conftest import Harness, tickets_csv


def allow(harness: Harness, *roots: Path) -> None:
    body = {"value": [str(root) for root in roots]}
    assert harness.client.put("/api/policies/data_folders", json=body).status_code == 200


@pytest.fixture
def exports(tmp_path: Path) -> Path:
    root = tmp_path / "exports"
    (root / "2025").mkdir(parents=True)
    (root / "2025" / "jan.csv").write_bytes(tickets_csv(120))
    (root / "feb.csv").write_bytes(tickets_csv(80))
    (root / "notes.txt").write_text("not data")
    (root / ".hidden.csv").write_bytes(tickets_csv(5))
    return root


def test_folders_need_an_allowed_root(harness: Harness, exports: Path) -> None:
    refused = harness.client.post("/api/sources/folders", json={"path": str(exports)})
    assert refused.status_code == 422 and "no folders are allowed" in refused.json()["detail"]
    allow(harness, exports / "2025")
    outside = harness.client.post("/api/sources/folders", json={"path": str(exports)})
    assert outside.status_code == 422 and "outside the folders" in outside.json()["detail"]
    sneaky = harness.client.post("/api/sources/folders", json={"path": str(exports / "2025" / "..")})
    assert sneaky.status_code == 422
    relative = harness.client.post("/api/sources/folders", json={"path": "exports"})
    assert "full path" in relative.json()["detail"]
    assert harness.client.get("/api/data/folders").json() == {"roots": [str(exports / "2025")], "locked": False}


def test_a_folder_reads_every_file_of_its_format_as_one_table(harness: Harness, exports: Path) -> None:
    allow(harness, exports)
    response = harness.client.post("/api/sources/folders", json={"path": str(exports), "name": "Ticket exports"})
    assert response.status_code == 201, response.text
    source = response.json()
    assert (source["kind"], source["table"], source["format"], source["files"]) == (
        "folder",
        "ticket_exports",
        ".csv",
        2,
    )
    assert source["rows"] == 200
    assert source["size"] == len(tickets_csv(120)) + len(tickets_csv(80))
    assert source["modified_at"] is not None
    created = harness.client.post(
        "/api/datasets",
        json={"name": "Exports", "sql": "SELECT text AS input, category AS label FROM ticket_exports"},
    )
    assert created.status_code == 201, created.text
    assert created.json()["rows"] == 200
    assert [ref["kind"] for ref in created.json()["sources"]] == ["folder"]


def test_new_files_show_up_and_the_policy_still_applies(harness: Harness, exports: Path) -> None:
    allow(harness, exports)
    source = harness.client.post("/api/sources/folders", json={"path": str(exports)}).json()
    (exports / "mar.csv").write_bytes(tickets_csv(30))
    again = harness.client.get(f"/api/sources/{source['id']}").json()
    assert (again["files"], again["rows"]) == (3, 230)
    allow(harness, exports / "2025")
    revoked = harness.client.get(f"/api/sources/{source['id']}").json()
    assert revoked["rows"] is None and "no longer in the folders" in revoked["error"]


def test_symlinks_inside_a_folder_are_never_read(harness: Harness, exports: Path, tmp_path: Path) -> None:
    secret = tmp_path / "secret.csv"
    secret.write_text("text,category\nthe password,secret\n")
    os.symlink(secret, exports / "link.csv")
    allow(harness, exports)
    source = harness.client.post("/api/sources/folders", json={"path": str(exports)}).json()
    assert (source["files"], source["rows"]) == (2, 200)
    direct = harness.client.post("/api/query", json={"sql": f"SELECT * FROM read_csv_auto('{exports / 'link.csv'}')"})
    assert direct.status_code == 422
    via_table = harness.client.post(
        "/api/query",
        json={"sql": f"SELECT * FROM {source['table']} UNION ALL SELECT * FROM read_csv_auto('{secret}')"},
    )
    assert via_table.status_code == 422
