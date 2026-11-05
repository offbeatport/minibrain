from pathlib import Path
from typing import Any

from alembic import command
from sqlalchemy import inspect, text

from minibrain.registry.db import make_engine
from tests.conftest import Harness, tickets_csv
from tests.test_data_catalogue import columns_of, migration_config
from tests.test_datasets import upload


def folder(harness: Harness, name: str, parent: int | None = None) -> dict[str, Any]:
    response = harness.client.post("/api/dataset-folders", json={"name": name, "parent_id": parent})
    assert response.status_code == 201, response.text
    return response.json()


def dataset(harness: Harness, name: str, folder_id: int | None = None) -> dict[str, Any]:
    source = upload(harness, f"{name}.csv", tickets_csv(20) + f"{name} ticket,billing\n".encode())
    body = {"name": name, "source_id": source["id"], "folder_id": folder_id}
    response = harness.client.post("/api/datasets", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def folders(harness: Harness) -> dict[str, int | None]:
    return {item["name"]: item["parent_id"] for item in harness.client.get("/api/dataset-folders").json()}


def placement(harness: Harness) -> dict[str, int | None]:
    return {item["slug"]: item["folder_id"] for item in harness.client.get("/api/datasets").json()}


def audited(harness: Harness, prefix: str) -> list[tuple[str, dict[str, Any]]]:
    events = harness.client.get("/api/audit").json()["events"]
    found = [event for event in reversed(events) if event["action"].startswith(prefix)]
    assert all(event["detail"].pop("sign_in") == "local" for event in found)
    return [(event["action"], event["detail"]) for event in found]


def test_folders_are_created_renamed_moved_and_audited(harness: Harness) -> None:
    support = folder(harness, "  Support  ")
    tickets = folder(harness, "Tickets", support["id"])
    archive = folder(harness, "Archive")
    assert (support["name"], tickets["parent_id"]) == ("Support", support["id"])
    renamed = harness.client.patch(f"/api/dataset-folders/{tickets['id']}", json={"name": "Help desk"})
    assert renamed.status_code == 200 and renamed.json()["name"] == "Help desk"
    moved = harness.client.put(f"/api/dataset-folders/{tickets['id']}/parent", json={"parent_id": archive["id"]})
    assert moved.status_code == 200 and moved.json()["parent_id"] == archive["id"]
    to_root = harness.client.put(f"/api/dataset-folders/{tickets['id']}/parent", json={"parent_id": None})
    assert to_root.json()["parent_id"] is None
    assert folders(harness) == {"Archive": None, "Help desk": None, "Support": None}
    assert harness.client.post("/api/dataset-folders", json={"name": "   "}).status_code == 422
    assert harness.client.post("/api/dataset-folders", json={"name": "X", "parent_id": 999}).status_code == 404
    assert audited(harness, "dataset_folder.") == [
        ("dataset_folder.create", {"name": "Support", "path": "/Support"}),
        ("dataset_folder.create", {"name": "Tickets", "path": "/Support/Tickets"}),
        ("dataset_folder.create", {"name": "Archive", "path": "/Archive"}),
        ("dataset_folder.rename", {"name": "Help desk", "from": "Tickets", "to": "Help desk"}),
        ("dataset_folder.move", {"name": "Help desk", "from": "/Support/Help desk", "to": "/Archive/Help desk"}),
        ("dataset_folder.move", {"name": "Help desk", "from": "/Archive/Help desk", "to": "/Help desk"}),
    ]


def test_folder_names_are_unique_among_siblings(harness: Harness) -> None:
    support = folder(harness, "Support")
    other = folder(harness, "Other")
    clash = harness.client.post("/api/dataset-folders", json={"name": "support"})
    assert clash.status_code == 409 and "Datasets already has a folder called Support" in clash.json()["detail"]
    inner = folder(harness, "Support", other["id"])
    nested = harness.client.post("/api/dataset-folders", json={"name": "SUPPORT", "parent_id": other["id"]})
    assert nested.status_code == 409 and "Other already has a folder called Support" in nested.json()["detail"]
    assert harness.client.patch(f"/api/dataset-folders/{other['id']}", json={"name": "Support"}).status_code == 409
    same = harness.client.patch(f"/api/dataset-folders/{support['id']}", json={"name": "support"})
    assert same.status_code == 200 and same.json()["name"] == "support"
    up = harness.client.put(f"/api/dataset-folders/{inner['id']}/parent", json={"parent_id": None})
    assert up.status_code == 409
    assert folders(harness) == {"Other": None, "Support": other["id"], "support": None}


def test_a_folder_cannot_move_into_itself_or_its_own_folders(harness: Harness) -> None:
    top = folder(harness, "Top")
    middle = folder(harness, "Middle", top["id"])
    bottom = folder(harness, "Bottom", middle["id"])
    for target in (top["id"], middle["id"], bottom["id"]):
        response = harness.client.put(f"/api/dataset-folders/{top['id']}/parent", json={"parent_id": target})
        assert response.status_code == 409, target
        assert "cannot go inside itself" in response.json()["detail"]
    sideways = harness.client.put(f"/api/dataset-folders/{bottom['id']}/parent", json={"parent_id": top["id"]})
    assert sideways.status_code == 200
    assert folders(harness) == {"Top": None, "Middle": top["id"], "Bottom": top["id"]}


def test_deleting_a_folder_moves_its_contents_up_one_level(harness: Harness) -> None:
    support = folder(harness, "Support")
    tickets = folder(harness, "Tickets", support["id"])
    folder(harness, "Billing", support["id"])
    nested = folder(harness, "Billing", tickets["id"])
    folder(harness, "Refunds", nested["id"])
    dataset(harness, "Routing", tickets["id"])
    dataset(harness, "Triage", support["id"])
    removed = harness.client.delete(f"/api/dataset-folders/{tickets['id']}")
    assert removed.status_code == 204
    assert folders(harness) == {
        "Support": None,
        "Billing": support["id"],
        "Billing (2)": support["id"],
        "Refunds": nested["id"],
    }
    assert placement(harness) == {"routing": support["id"], "triage": support["id"]}
    assert harness.client.delete(f"/api/dataset-folders/{support['id']}").status_code == 204
    assert folders(harness) == {"Billing": None, "Billing (2)": None, "Refunds": nested["id"]}
    assert placement(harness) == {"routing": None, "triage": None}
    assert harness.client.delete(f"/api/dataset-folders/{tickets['id']}").status_code == 404
    deletes = [detail for action, detail in audited(harness, "dataset_folder.delete")]
    assert deletes == [
        {
            "name": "Tickets",
            "path": "/Support/Tickets",
            "folders": 1,
            "datasets": 1,
            "renamed": ["Billing → Billing (2)"],
        },
        {"name": "Support", "path": "/Support", "folders": 2, "datasets": 2},
    ]


def test_datasets_move_between_folders_and_the_top_level(harness: Harness) -> None:
    support = folder(harness, "Support")
    tickets = folder(harness, "Tickets", support["id"])
    created = dataset(harness, "Routing", support["id"])
    assert created["folder_id"] == support["id"]
    moved = harness.client.put("/api/datasets/routing/folder", json={"folder_id": tickets["id"]})
    assert moved.status_code == 200 and moved.json()["folder_id"] == tickets["id"]
    assert harness.client.put("/api/datasets/routing/folder", json={"folder_id": 999}).status_code == 404
    assert harness.client.put("/api/datasets/missing/folder", json={"folder_id": None}).status_code == 404
    top = harness.client.put("/api/datasets/routing/folder", json={"folder_id": None})
    assert top.status_code == 200 and top.json()["folder_id"] is None
    assert harness.client.put("/api/datasets/routing/folder", json={"folder_id": None}).status_code == 200
    missing = upload(harness, "other.csv", tickets_csv(21))
    body = {"name": "Lost", "source_id": missing["id"], "folder_id": 999}
    assert harness.client.post("/api/datasets", json=body).status_code == 404
    assert placement(harness) == {"routing": None}
    assert audited(harness, "dataset.move") == [
        ("dataset.move", {"name": "Routing", "from": "/Support", "to": "/Support/Tickets"}),
        ("dataset.move", {"name": "Routing", "from": "/Support/Tickets", "to": "/"}),
    ]


def test_migration_adds_dataset_folders_and_removes_them(tmp_path: Path) -> None:
    engine = make_engine(f"sqlite:///{tmp_path / 'old.db'}", foreign_keys=False)
    config = migration_config(engine)
    command.upgrade(config, "0027")
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO datasets (slug, name, created_at, updated_at) "
                "VALUES ('tickets', 'Tickets', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            )
        )
    command.upgrade(config, "0028")
    assert "folder_id" in columns_of(engine, "datasets")
    keys = inspect(engine).get_foreign_keys("datasets")
    assert {"name": "fk_datasets_folder", "ondelete": "SET NULL"} in [
        {"name": key["name"], "ondelete": key.get("options", {}).get("ondelete")} for key in keys
    ]
    with engine.begin() as connection:
        connection.execute(text("INSERT INTO dataset_folders (name, created_at) VALUES ('Support', CURRENT_TIMESTAMP)"))
        connection.execute(text("UPDATE datasets SET folder_id = 1"))
        assert connection.execute(text("SELECT slug, folder_id FROM datasets")).all() == [("tickets", 1)]
        table = connection.execute(text("SELECT sql FROM sqlite_master WHERE name = 'dataset_folders'")).scalar_one()
        assert "AUTOINCREMENT" in table
    command.downgrade(config, "0027")
    assert "dataset_folders" not in inspect(engine).get_table_names()
    assert "folder_id" not in columns_of(engine, "datasets")
    with engine.connect() as connection:
        assert connection.execute(text("SELECT slug FROM datasets")).scalars().all() == ["tickets"]
