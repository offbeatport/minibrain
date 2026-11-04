from sqlalchemy import select

from minibrain.registry.models import Snapshot
from tests.conftest import Harness, tickets_csv


def upload(harness: Harness, name: str = "tickets.csv") -> dict:
    response = harness.client.post("/api/sources", files={"file": (name, tickets_csv(), "text/csv")})
    assert response.status_code == 201, response.text
    return response.json()


def snapshot_hash(harness: Harness, slug: str) -> str:
    response = harness.client.post(f"/api/minibrains/{slug}/snapshots")
    assert response.status_code == 201, response.text
    return response.json()["snapshot"]["hash"]


def test_two_models_train_on_one_shared_dataset(harness: Harness) -> None:
    source = upload(harness)
    assert (source["rows"], [column["name"] for column in source["columns"]]) == (200, ["text", "category"])
    dataset = harness.client.post("/api/datasets", json={"name": "Tickets", "source_id": source["id"]}).json()
    assert (dataset["slug"], dataset["mapping"]["input_column"], dataset["mapping"]["label_column"]) == (
        "tickets",
        "text",
        "category",
    )
    for name in ("Triage A", "Triage B"):
        harness.client.post("/api/minibrains", json={"name": name})
    for slug in ("triage-a", "triage-b"):
        chosen = harness.client.put(f"/api/minibrains/{slug}/dataset", json={"dataset": "tickets"}).json()
        assert (chosen["dataset"], chosen["source"]["rows"]) == ("tickets", 200)
    assert snapshot_hash(harness, "triage-a") == snapshot_hash(harness, "triage-b")
    assert harness.client.get("/api/datasets/tickets").json()["models"] == ["triage-a", "triage-b"]


def test_deleting_a_dataset_in_use_releases_its_models_and_keeps_their_snapshots(harness: Harness) -> None:
    source = upload(harness)
    harness.client.post("/api/datasets", json={"name": "Tickets", "source_id": source["id"]})
    harness.client.post("/api/minibrains", json={"name": "Triage"})
    harness.client.put("/api/minibrains/triage/dataset", json={"dataset": "tickets"})
    taken = snapshot_hash(harness, "triage")
    assert harness.client.post("/api/minibrains/triage/versions", json={"kind": "prompt"}).status_code == 201
    assert harness.client.get("/api/datasets/tickets").json()["model_names"] == ["Triage"]
    assert "used by Tickets" in harness.client.delete(f"/api/sources/{source['id']}").json()["detail"]
    assert harness.client.delete("/api/datasets/tickets").status_code == 204
    model = harness.client.get("/api/minibrains/triage").json()
    assert model["dataset"] is None
    with harness.sessions() as session:
        kept = session.scalar(select(Snapshot).where(Snapshot.hash == taken))
        assert kept is not None and kept.dataset_id is None
    events = harness.client.get("/api/audit", params={"action": "dataset.delete"}).json()["events"]
    assert events[0]["detail"]["models"] == ["triage"]
    assert harness.client.delete(f"/api/sources/{source['id']}").status_code == 204


def test_uploading_to_a_model_never_changes_a_dataset_other_models_use(harness: Harness) -> None:
    source = upload(harness)
    harness.client.post("/api/datasets", json={"name": "Tickets", "source_id": source["id"]})
    for name in ("Triage A", "Triage B"):
        harness.client.post("/api/minibrains", json={"name": name})
        harness.client.put(f"/api/minibrains/{name.lower().replace(' ', '-')}/dataset", json={"dataset": "tickets"})
    files = {"file": ("other.csv", tickets_csv(50), "text/csv")}
    replaced = harness.client.post("/api/minibrains/triage-a/source", files=files).json()
    assert replaced["dataset"] != "tickets" and replaced["source"]["rows"] == 50
    assert harness.client.get("/api/minibrains/triage-b").json()["source"]["rows"] == 200
    mapped = harness.client.put(
        "/api/datasets/tickets/mapping", json={"sql": "SELECT text AS input, category AS label FROM source"}
    )
    assert mapped.json()["mapping"]["input_column"] is None
    assert len(harness.client.get("/api/datasets/tickets/preview").json()["labels"]) == 4
