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


def test_datasets_and_sources_in_use_cannot_be_deleted(harness: Harness) -> None:
    source = upload(harness)
    harness.client.post("/api/datasets", json={"name": "Tickets", "source_id": source["id"]})
    harness.client.post("/api/minibrains", json={"name": "Triage"})
    harness.client.put("/api/minibrains/triage/dataset", json={"dataset": "tickets"})
    assert "used by Triage" in harness.client.delete("/api/datasets/tickets").json()["detail"]
    assert "used by Tickets" in harness.client.delete(f"/api/sources/{source['id']}").json()["detail"]
    harness.client.put("/api/minibrains/triage/dataset", json={"dataset": None})
    assert harness.client.delete("/api/datasets/tickets").status_code == 204
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
