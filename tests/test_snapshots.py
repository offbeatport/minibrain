from pathlib import Path

from alembic import command
from sqlalchemy import select, text

from minibrain.data import snapshot as splits
from minibrain.registry.db import make_engine
from minibrain.registry.files import store_for
from minibrain.registry.models import Artifact, Snapshot
from tests.conftest import Harness, tickets_csv
from tests.test_data_catalogue import migration_config
from tests.test_flow import SLUG, finish


def upload(harness: Harness, rows: int = 200, name: str = "tickets.csv") -> dict:
    response = harness.client.post("/api/sources", files={"file": (name, tickets_csv(rows), "text/csv")})
    assert response.status_code == 201, response.text
    return response.json()


def dataset_with_model(harness: Harness, rows: int = 200) -> dict:
    source = upload(harness, rows)
    harness.client.post("/api/datasets", json={"name": "Tickets", "source_id": source["id"]})
    harness.client.post("/api/minibrains", json={"name": "Support Triage"})
    harness.client.put(f"/api/minibrains/{SLUG}/dataset", json={"dataset": "tickets"})
    return source


def save(harness: Harness, slug: str = "tickets") -> dict:
    response = harness.client.post(f"/api/datasets/{slug}/snapshots")
    assert response.status_code == 201, response.text
    return response.json()


def test_a_saved_snapshot_is_a_content_hashed_parquet_copy(harness: Harness) -> None:
    dataset_with_model(harness)
    first = save(harness)
    assert (first["rows"], first["saved"], first["dataset"], first["versions"]) == (200, True, "tickets", [])
    assert first["counts"] == {"golden": 20, "eval": 30, "shots": 4, "train": 146}
    store = store_for(harness.settings)
    assert store.has(first["hash"])
    with store.open(first["hash"]) as stream:
        assert stream.read(4) == b"PAR1"
    again = save(harness)
    assert (again["id"], again["hash"]) == (first["id"], first["hash"])
    harness.client.put(
        "/api/datasets/tickets/mapping",
        json={"sql": "SELECT text AS input, category AS label FROM tickets WHERE category <> 'bug'"},
    )
    filtered = save(harness)
    assert filtered["hash"] != first["hash"] and filtered["rows"] == 150
    listed = harness.client.get("/api/datasets/tickets/snapshots").json()
    assert [item["id"] for item in listed] == [filtered["id"], first["id"]]
    summary = harness.client.get("/api/datasets/tickets").json()
    assert summary["snapshot"]["id"] == filtered["id"]
    assert summary["changed"] == {"data": False, "query": False, "dataset": False}


def test_training_starts_from_a_fresh_snapshot_recorded_on_the_version(harness: Harness) -> None:
    dataset_with_model(harness)
    prepared = harness.client.post(f"/api/minibrains/{SLUG}/snapshots").json()["snapshot"]
    version = harness.client.post(f"/api/minibrains/{SLUG}/versions", json={"kind": "lora", "max_rows": 100})
    assert version.status_code == 201, version.text
    assert (version.json()["snapshot_id"], version.json()["snapshot_dataset"]) == (prepared["id"], "tickets")
    claim = harness.claim(["train"])
    assert claim is not None
    assert claim["params"]["snapshot"]["packing"] == "file"
    assert claim["params"]["snapshot"]["name"] == "snapshot.parquet"
    harness.client.put(
        "/api/datasets/tickets/mapping",
        json={"sql": "SELECT text AS input, category AS label FROM tickets WHERE category <> 'feature'"},
    )
    detail = harness.client.get(f"/api/minibrains/{SLUG}").json()
    assert detail["changed"] == {"data": False, "query": True, "dataset": False}
    scored = harness.client.post(f"/api/minibrains/{SLUG}/versions", json={"kind": "prompt"}).json()
    assert scored["snapshot_id"] != prepared["id"] and scored["snapshot_rows"] == 150
    detail = harness.client.get(f"/api/minibrains/{SLUG}").json()
    assert detail["changed"] == {"data": False, "query": False, "dataset": False}


def test_splits_are_derived_from_the_parquet_file(harness: Harness) -> None:
    dataset_with_model(harness)
    taken = save(harness)
    path = store_for(harness.settings).materialize(taken["hash"], "file", "snapshot.parquet")
    assert [len(splits.read_split(path, name)) for name in splits.SPLITS] == [20, 30, 4, 146]
    assert splits.read_labels(path) == ["account", "billing", "bug", "feature"]
    labels, shots = splits.prompt_context(str(path))
    assert len(labels) == 4 and len(shots) == 4


def test_the_row_limit_refuses_large_snapshots_with_a_way_out(harness: Harness) -> None:
    dataset_with_model(harness)
    current = harness.client.get("/api/settings/data").json()
    assert (current["row_limit"], current["keep_snapshots"]) == (200_000, 5)
    changed = harness.client.put("/api/settings/data", json={"row_limit": 150}).json()
    assert (changed["row_limit"], changed["keep_snapshots"]) == (150, 5)
    assert harness.client.get("/api/datasets/tickets").json()["row_limit"] == 150
    refused = harness.client.post("/api/datasets/tickets/snapshots")
    assert refused.status_code == 409
    assert "more than 150 rows" in refused.json()["detail"] and "USING SAMPLE" in refused.json()["detail"]
    blocked = harness.client.post(f"/api/minibrains/{SLUG}/versions", json={"kind": "prompt"})
    assert blocked.status_code == 409
    assert harness.client.put("/api/settings/data", json={"row_limit": 5}).status_code == 422


def test_too_few_rows_block_training_but_not_saving(harness: Harness) -> None:
    dataset_with_model(harness, rows=40)
    assert save(harness)["counts"] == {}
    refused = harness.client.post(f"/api/minibrains/{SLUG}/versions", json={"kind": "prompt"})
    assert refused.status_code == 409 and "fewer than 100" in refused.json()["detail"]


def test_folder_changes_show_as_data_changed(harness: Harness, tmp_path: Path) -> None:
    root = tmp_path / "exports"
    root.mkdir()
    (root / "jan.csv").write_bytes(tickets_csv(150))
    harness.client.put("/api/policies/data_folders", json={"value": [str(root)]})
    source = harness.client.post("/api/sources/folders", json={"path": str(root), "name": "Exports"}).json()
    harness.client.post("/api/datasets", json={"name": "Exports", "source_id": source["id"]})
    save(harness, "exports")
    assert harness.client.get("/api/datasets/exports").json()["changed"]["data"] is False
    (root / "feb.csv").write_bytes(tickets_csv(60))
    summary = harness.client.get("/api/datasets/exports").json()
    assert summary["changed"] == {"data": True, "query": False, "dataset": False}
    assert summary["splits"] is None
    assert save(harness, "exports")["rows"] == 210


def stored_snapshots(harness: Harness) -> list[Snapshot]:
    with harness.sessions() as session:
        return list(session.scalars(select(Snapshot).order_by(Snapshot.id)))


def test_retention_keeps_used_snapshots_and_the_last_saved_ones(harness: Harness) -> None:
    dataset_with_model(harness)
    harness.client.put("/api/settings/data", json={"keep_snapshots": 2})
    saved = []
    for category in ("bug", "feature", "account"):
        harness.client.put(
            "/api/datasets/tickets/mapping",
            json={"sql": f"SELECT text AS input, category AS label FROM tickets WHERE category <> '{category}'"},
        )
        saved.append(save(harness)["id"])
    assert [snapshot.id for snapshot in stored_snapshots(harness)] == saved[1:]
    harness.client.put("/api/datasets/tickets/mapping", json={"input_column": "text", "label_column": "category"})
    trained = harness.client.post(f"/api/minibrains/{SLUG}/versions", json={"kind": "prompt"}).json()
    finish(harness, "eval")
    kept = {snapshot.id for snapshot in stored_snapshots(harness)}
    assert trained["snapshot_id"] in kept and set(saved[1:]) <= kept
    harness.client.put(
        "/api/datasets/tickets/mapping",
        json={"sql": "SELECT text AS input, category AS label FROM tickets WHERE text <> ''"},
    )
    later = harness.client.post(f"/api/minibrains/{SLUG}/snapshots").json()["snapshot"]
    assert later["id"] == trained["snapshot_id"] and later["saved"] is True
    assert harness.client.delete(f"/api/minibrains/{SLUG}/versions/0").status_code == 204
    assert trained["snapshot_id"] in {snapshot.id for snapshot in stored_snapshots(harness)}


def test_snapshots_of_deleted_versions_are_removed_with_their_files(harness: Harness) -> None:
    dataset_with_model(harness)
    version = harness.client.post(f"/api/minibrains/{SLUG}/versions", json={"kind": "prompt"}).json()
    snapshot = next(item for item in stored_snapshots(harness) if item.id == version["snapshot_id"])
    assert snapshot.saved is False
    harness.client.put(
        "/api/datasets/tickets/mapping",
        json={"sql": "SELECT text AS input, category AS label FROM tickets WHERE category <> 'bug'"},
    )
    assert harness.client.post(f"/api/minibrains/{SLUG}/versions", json={"kind": "prompt"}).status_code == 201
    finish(harness, "eval")
    finish(harness, "eval")
    assert harness.client.delete(f"/api/minibrains/{SLUG}/versions/0").status_code == 204
    assert snapshot.id not in {item.id for item in stored_snapshots(harness)}
    assert not store_for(harness.settings).has(snapshot.hash)
    with harness.sessions() as session:
        assert session.get(Artifact, snapshot.hash) is None
    assert harness.client.get("/api/system/infrastructure").json()["snapshots"]["for_versions"] == 1


def test_snapshot_migrations_round_trip(tmp_path: Path) -> None:
    engine = make_engine(f"sqlite:///{tmp_path / 'old.db'}", foreign_keys=False)
    config = migration_config(engine)
    command.upgrade(config, "0019")
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO minibrains (slug, name, task, base_model, created_at) "
                "VALUES ('m', 'M', 'classify', 'qwen3-0.6b', CURRENT_TIMESTAMP)"
            )
        )
        connection.execute(
            text(
                "INSERT INTO snapshots (minibrain_id, hash, counts, labels, created_at) "
                "VALUES (1, 'h', '{}', '[]', CURRENT_TIMESTAMP)"
            )
        )
        connection.execute(
            text(
                "INSERT INTO jobs (kind, params, needs_gpu, status, priority, attempt, max_attempts, run_after, "
                "cancel_requested, progress, outputs, created_at) VALUES ('prepare', '{}', 0, 'queued', 0, 0, 3, "
                "CURRENT_TIMESTAMP, 0, 0, '{}', CURRENT_TIMESTAMP)"
            )
        )
    command.upgrade(config, "0021")
    with engine.connect() as connection:
        assert connection.execute(text("SELECT saved, rows, dataset_id FROM snapshots")).all() == [(0, 0, None)]
        assert connection.execute(text("SELECT status FROM jobs")).scalars().all() == ["cancelled"]
        assert connection.execute(text("SELECT snapshot_id FROM minibrains")).scalars().all() == [None]
    command.downgrade(config, "0019")
    with engine.connect() as connection:
        assert connection.execute(text("SELECT minibrain_id FROM snapshots")).scalars().all() == [1]


def test_two_snapshots_diff_by_input_with_label_shift(harness: Harness) -> None:
    dataset_with_model(harness)
    before = save(harness)
    harness.client.put(
        "/api/datasets/tickets/mapping",
        json={
            "sql": "SELECT text AS input, CASE WHEN text = 'ticket 0 about billing' THEN 'bug' "
            "ELSE category END AS label FROM tickets WHERE category <> 'feature' "
            "UNION ALL SELECT 'a brand new ticket', 'billing'"
        },
    )
    after = save(harness)
    diff = harness.client.get(f"/api/snapshots/{before['id']}/diff/{after['id']}")
    assert diff.status_code == 200, diff.text
    found = diff.json()
    assert (found["before"]["id"], found["after"]["id"]) == (before["id"], after["id"])
    assert (found["added"], found["removed"], found["relabelled"], found["unchanged"]) == (1, 50, 1, 149)
    assert found["added_rows"] == [{"input": "a brand new ticket", "label": "billing"}]
    assert found["relabelled_rows"] == [{"input": "ticket 0 about billing", "before": "billing", "after": "bug"}]
    shifts = {item["label"]: (item["before"], item["after"]) for item in found["labels"]}
    assert shifts == {"billing": (50, 50), "bug": (50, 51), "account": (50, 50), "feature": (50, 0)}
    assert harness.client.get(f"/api/snapshots/{after['id']}").json()["rows"] == 151
    assert harness.client.get("/api/snapshots/999/diff/1").status_code == 404
