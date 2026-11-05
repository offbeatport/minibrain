from pathlib import Path

import pytest
from sqlalchemy import select

from minibrain.data import snapshot as splits
from minibrain.registry.files import store_for
from minibrain.registry.models import Artifact, Snapshot
from tests.conftest import Harness, tickets_csv
from tests.test_flow import SLUG, finish

pytestmark = pytest.mark.both_stores


def upload(harness: Harness, rows: int = 200, name: str = "tickets.csv") -> dict:
    response = harness.client.post("/api/sources", files={"file": (name, tickets_csv(rows), "text/csv")})
    assert response.status_code == 201, response.text
    return response.json()


def dataset_with_model(harness: Harness, rows: int = 200) -> dict:
    source = upload(harness, rows)
    harness.client.post("/api/datasets", json={"name": "Tickets", "source_id": source["id"]})
    harness.client.post("/api/models", json={"labels": ["billing", "bug"], "name": "Support Triage"})
    harness.client.put(f"/api/models/{SLUG}/dataset", json={"dataset": "tickets"})
    return source


def save(harness: Harness, slug: str = "tickets") -> dict:
    response = harness.client.post(f"/api/datasets/{slug}/snapshots")
    assert response.status_code == 201, response.text
    return response.json()


def versions(harness: Harness, slug: str = "tickets") -> list[dict]:
    return harness.client.get(f"/api/datasets/{slug}/snapshots").json()


def remap(harness: Harness, where: str, slug: str = "tickets") -> dict:
    sql = f"SELECT text AS input, category AS label FROM tickets WHERE {where}"
    response = harness.client.put(f"/api/datasets/{slug}/mapping", json={"sql": sql})
    assert response.status_code == 200, response.text
    return response.json()["snapshot"]


def test_creating_a_dataset_saves_version_1_as_a_content_hashed_parquet_copy(harness: Harness) -> None:
    dataset_with_model(harness)
    [first] = versions(harness)
    assert (first["number"], first["rows"], first["saved"], first["dataset"], first["versions"]) == (
        1,
        200,
        True,
        "tickets",
        [],
    )
    assert first["counts"] == {"golden": 20, "eval": 30, "shots": 4, "train": 146}
    store = store_for(harness.settings)
    assert store.has(first["hash"])
    with store.open(first["hash"]) as stream:
        assert stream.read(4) == b"PAR1"
    again = save(harness)
    assert (again["id"], again["hash"], again["number"]) == (first["id"], first["hash"], 1)
    filtered = remap(harness, "category <> 'bug'")
    assert (filtered["number"], filtered["rows"]) == (2, 150) and filtered["hash"] != first["hash"]
    assert [item["number"] for item in versions(harness)] == [2, 1]
    summary = harness.client.get("/api/datasets/tickets").json()
    assert summary["snapshot"]["id"] == filtered["id"]
    assert summary["changed"] == {"data": False, "query": False, "dataset": False}
    back = remap(harness, "category IS NOT NULL")
    assert (back["number"], back["hash"]) == (3, first["hash"])


def test_a_dataset_with_no_columns_picked_has_no_version_until_it_is_mapped(harness: Harness) -> None:
    rows = "\n".join(["question,team", *(f"ticket {n},{'ab'[n % 2]}" for n in range(120))]).encode()
    response = harness.client.post("/api/sources", files={"file": ("plain.csv", rows, "text/csv")})
    assert response.status_code == 201, response.text
    created = harness.client.post("/api/datasets", json={"name": "Plain", "source_id": response.json()["id"]})
    assert created.status_code == 201, created.text
    assert (created.json()["mapping"]["sql"], created.json()["snapshot"]) == (None, None)
    assert versions(harness, "plain") == []
    mapped = harness.client.put(
        "/api/datasets/plain/mapping",
        json={"source_id": response.json()["id"], "input_column": "question", "label_column": "team"},
    )
    assert mapped.status_code == 200, mapped.text
    assert [item["number"] for item in versions(harness, "plain")] == [1]
    stacked = harness.client.post(
        "/api/datasets", json={"name": "Stacked", "sql": "SELECT question AS input, team AS label FROM plain"}
    )
    assert stacked.status_code == 201, stacked.text
    assert stacked.json()["snapshot"]["number"] == 1


def test_training_uses_the_chosen_dataset_version(harness: Harness) -> None:
    source = dataset_with_model(harness)
    [first] = versions(harness)
    second = remap(harness, "category <> 'feature'")
    assert harness.client.get(f"/api/models/{SLUG}").json()["snapshot"]["id"] == second["id"]
    chosen = {"kind": "lora", "max_rows": 100, "snapshot_id": first["id"]}
    version = harness.client.post(f"/api/models/{SLUG}/versions", json=chosen)
    assert version.status_code == 201, version.text
    found = version.json()
    assert (found["snapshot_id"], found["snapshot_number"], found["snapshot_dataset"]) == (first["id"], 1, "tickets")
    claim = harness.claim(["train"])
    assert claim is not None
    assert claim["params"]["snapshot"]["packing"] == "file"
    assert claim["params"]["snapshot"]["name"] == "snapshot.parquet"
    assert claim["params"]["snapshot"]["id"] == first["hash"]
    scored = harness.client.post(f"/api/models/{SLUG}/versions", json={"kind": "prompt"}).json()
    assert (scored["snapshot_id"], scored["snapshot_number"], scored["snapshot_rows"]) == (second["id"], 2, 150)
    assert [item["number"] for item in versions(harness)] == [2, 1]
    other = harness.client.post("/api/datasets", json={"name": "Other", "source_id": source["id"]})
    assert other.status_code == 201, other.text
    for wrong in (999, other.json()["snapshot"]["id"]):
        refused = harness.client.post(f"/api/models/{SLUG}/versions", json={"kind": "prompt", "snapshot_id": wrong})
        assert refused.status_code == 409 and "pick a version" in refused.json()["detail"]


def test_a_source_change_offers_an_update_that_makes_the_next_version(harness: Harness, tmp_path: Path) -> None:
    root = tmp_path / "exports"
    root.mkdir()
    (root / "jan.csv").write_bytes(tickets_csv(150))
    harness.client.put("/api/policies/data_folders", json={"value": [str(root)]})
    source = harness.client.post("/api/sources/folders", json={"path": str(root), "name": "Exports"}).json()
    created = harness.client.post("/api/datasets", json={"name": "Exports", "source_id": source["id"]}).json()
    assert (created["snapshot"]["number"], created["snapshot"]["rows"]) == (1, 150)
    assert created["changed"] == {"data": False, "query": False, "dataset": False}
    (root / "feb.csv").write_bytes(tickets_csv(60))
    summary = harness.client.get("/api/datasets/exports").json()
    assert summary["changed"] == {"data": True, "query": False, "dataset": False}
    assert summary["splits"] is None and summary["snapshot"]["number"] == 1
    updated = save(harness, "exports")
    assert (updated["number"], updated["rows"]) == (2, 210)
    after = harness.client.get("/api/datasets/exports").json()
    assert after["changed"]["data"] is False and after["snapshot"]["number"] == 2


def test_splits_are_derived_from_the_parquet_file(harness: Harness) -> None:
    dataset_with_model(harness)
    taken = save(harness)
    path = store_for(harness.settings).materialize(taken["hash"], "file", "snapshot.parquet")
    assert [len(splits.read_split(path, name)) for name in splits.SPLITS] == [20, 30, 4, 146]
    found = splits.parquet_splits(str(path))
    assert splits.labels_of(found) == ["account", "billing", "bug", "feature"]
    assert {shot.expected for shot in found["shots"]} == {"account", "billing", "bug", "feature"}


def test_the_row_limit_refuses_large_versions_with_a_way_out(harness: Harness) -> None:
    source = dataset_with_model(harness)
    current = harness.client.get("/api/settings/data").json()
    assert (current["row_limit"], current["keep_snapshots"]) == (200_000, 5)
    changed = harness.client.put("/api/settings/data", json={"row_limit": 150}).json()
    assert (changed["row_limit"], changed["keep_snapshots"]) == (150, 5)
    assert harness.client.get("/api/datasets/tickets").json()["row_limit"] == 150
    refused = harness.client.post("/api/datasets/tickets/snapshots")
    assert refused.status_code == 409
    assert "more than 150 rows" in refused.json()["detail"] and "USING SAMPLE" in refused.json()["detail"]
    created = harness.client.post("/api/datasets", json={"name": "Too big", "source_id": source["id"]})
    assert created.status_code == 409 and "more than 150 rows" in created.json()["detail"]
    assert harness.client.get("/api/datasets/too-big").status_code == 404
    remapped = harness.client.put(
        "/api/datasets/tickets/mapping",
        json={"sql": "SELECT text AS input, category AS label FROM tickets WHERE text <> ''"},
    )
    assert remapped.status_code == 409
    assert harness.client.get("/api/datasets/tickets").json()["mapping"]["input_column"] == "text"
    assert harness.client.post(f"/api/models/{SLUG}/versions", json={"kind": "prompt"}).status_code == 201
    assert harness.client.put("/api/settings/data", json={"row_limit": 5}).status_code == 422


def test_too_few_rows_block_training_but_not_saving(harness: Harness) -> None:
    dataset_with_model(harness, rows=40)
    assert versions(harness)[0]["counts"] == {}
    refused = harness.client.post(f"/api/models/{SLUG}/versions", json={"kind": "prompt"})
    assert refused.status_code == 409 and "fewer than 100" in refused.json()["detail"]


def stored_snapshots(harness: Harness) -> list[Snapshot]:
    with harness.sessions() as session:
        return list(session.scalars(select(Snapshot).order_by(Snapshot.id)))


def numbers(harness: Harness) -> list[int | None]:
    return [snapshot.number for snapshot in stored_snapshots(harness)]


def test_retention_keeps_used_versions_the_latest_and_the_last_unused_ones(harness: Harness) -> None:
    dataset_with_model(harness)
    harness.client.put("/api/settings/data", json={"keep_snapshots": 2})
    for category in ("bug", "feature", "account"):
        remap(harness, f"category <> '{category}'")
    assert numbers(harness) == [3, 4]
    third = versions(harness)[1]
    trained = harness.client.post(
        f"/api/models/{SLUG}/versions", json={"kind": "prompt", "snapshot_id": third["id"]}
    ).json()
    assert trained["snapshot_id"] == third["id"]
    finish(harness, "eval")
    remap(harness, "text <> ''")
    remap(harness, "category <> 'billing'")
    assert numbers(harness) == [3, 5, 6]
    assert harness.client.put("/api/settings/data", json={"keep_snapshots": 0}).status_code == 200
    assert numbers(harness) == [3, 6]
    assert harness.client.delete(f"/api/models/{SLUG}/versions/1").status_code == 204
    assert numbers(harness) == [6]


def test_feedback_copies_are_removed_with_their_versions(harness: Harness) -> None:
    dataset_with_model(harness)
    [first] = versions(harness)
    played = harness.client.post(
        f"/api/models/{SLUG}/feedback",
        json={"rating": "down", "input": "ticket 0 about billing", "output": "billing", "correction": "bug"},
    ).json()
    assert harness.client.post(f"/api/feedback/{played['id']}/review", json={"decision": "accept"}).status_code == 200
    version = harness.client.post(f"/api/models/{SLUG}/versions", json={"kind": "prompt"}).json()
    copy = next(item for item in stored_snapshots(harness) if item.id == version["snapshot_id"])
    assert (copy.number, copy.base_id, copy.feedback_rows, copy.saved) == (None, first["id"], 1, False)
    assert version["snapshot_number"] == 1
    assert versions(harness)[0]["versions"] == [f"{SLUG}@1"]
    finish(harness, "eval")
    assert harness.client.delete(f"/api/models/{SLUG}/versions/1").status_code == 204
    assert [item.id for item in stored_snapshots(harness)] == [first["id"]]
    assert not store_for(harness.settings).has(copy.hash)
    with harness.sessions() as session:
        assert session.get(Artifact, copy.hash) is None
    assert harness.client.get("/api/system/infrastructure").json()["snapshots"]["for_versions"] == 0


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
    assert found["after"]["rows"] == 151
    assert harness.client.get("/api/snapshots/999/diff/1").status_code == 404
