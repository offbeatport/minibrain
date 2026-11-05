import hashlib
import json
import re
from pathlib import Path
from typing import Any

from jsonschema import Draft7Validator
from referencing import Registry, Resource

from minibrain.registry.models import Version
from tests.conftest import LABELS, Harness, fake_adapter, tickets_csv
from tests.test_flow import SLUG
from tests.test_model_card import CARD, trained_card

SCHEMAS = Path(__file__).parent / "cyclonedx"
BASE_HASH = "ab" * 32
STAMP = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ")


def validator() -> Draft7Validator:
    loaded = {name: json.loads((SCHEMAS / name).read_text()) for name in ("spdx.schema.json", "jsf-0.82.schema.json")}
    registry: Registry = Registry().with_resources(
        (schema["$id"], Resource.from_contents(schema)) for schema in loaded.values()
    )
    return Draft7Validator(json.loads((SCHEMAS / "bom-1.6.schema.json").read_text()), registry=registry)


def assert_valid(bom: dict[str, Any]) -> None:
    errors = sorted(validator().iter_errors(bom), key=lambda error: list(error.absolute_path))
    assert not errors, "\n".join(f"{list(error.absolute_path)}: {error.message}" for error in errors[:5])


def aibom(harness: Harness, number: int) -> dict[str, Any]:
    response = harness.client.get(f"{CARD}/{number}/aibom.json")
    assert response.status_code == 200, response.text
    return response.json()


def props(item: dict[str, Any]) -> dict[str, str]:
    return {entry["name"]: entry["value"] for entry in item.get("properties", [])}


def by_type(bom: dict[str, Any], kind: str) -> list[dict[str, Any]]:
    return [component for component in bom["components"] if component["type"] == kind]


def recomputed(bom: dict[str, Any]) -> str:
    body = json.loads(json.dumps(bom))
    body.pop("serialNumber")
    body["metadata"].pop("properties")
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode()).hexdigest()


def test_trained_version_is_a_valid_cyclonedx_ml_bom(harness: Harness) -> None:
    card = trained_card(harness)["card"]
    with harness.sessions() as session:
        stored = session.query(Version).filter(Version.number == 1).one()
        stored.base_hash = BASE_HASH
        adapter_id = stored.adapter_artifact_id
        session.commit()
    bom = aibom(harness, 1)
    assert_valid(bom)
    assert (bom["bomFormat"], bom["specVersion"], bom["version"]) == ("CycloneDX", "1.6", 1)
    assert STAMP.fullmatch(bom["metadata"]["timestamp"])
    assert bom["metadata"]["tools"]["components"][0]["name"] == "minibrain"
    model = bom["metadata"]["component"]
    assert (model["type"], model["name"], model["version"]) == ("machine-learning-model", SLUG, "1")
    facts = props(model)
    assert facts["minibrain:training:method"] == "lora"
    assert facts["minibrain:recipe:epochs"] == "2"
    assert facts["minibrain:recipe:learning_rate"] == "0.0002"
    assert facts["minibrain:recipe:rank"] == "16"
    assert facts["minibrain:training:train_loss"] == "0.4322"
    assert model["externalReferences"][0]["type"] == "model-card"
    parameters = model["modelCard"]["modelParameters"]
    snapshot = by_type(bom, "data")[0]
    assert parameters["datasets"] == [{"ref": snapshot["bom-ref"]}]
    assert parameters["approach"] == {"type": "supervised"}
    assert parameters["modelArchitecture"] == "LoRA adapter on Qwen/Qwen3-0.6B"
    assert sorted(entry["value"] for entry in model["modelCard"]["properties"]) == sorted(LABELS)
    measured = model["modelCard"]["quantitativeAnalysis"]["performanceMetrics"]
    metrics = {(m["type"], m["slice"]): m["value"] for m in measured}
    assert metrics[("accuracy", "held-out")] == "0.8333"
    assert metrics[("macro-f1", "held-out")] == "0.8469"
    assert metrics[("examples", "test")] == "20"
    assert metrics[("recall", "held-out, label billing")] == "0.375"
    assert metrics[("latency-p50-ms", "held-out")] == "41.2"
    limits = model["modelCard"]["considerations"]["technicalLimitations"]
    assert limits == [limit["text"] for limit in card["limits"]["derived"]]

    base = by_type(bom, "machine-learning-model")[0]
    expected = card["base_model"]
    assert (base["name"], base["version"]) == ("Qwen/Qwen3-0.6B", expected["revision"])
    assert base["purl"] == f"pkg:huggingface/Qwen/Qwen3-0.6B@{expected['revision'].lower()}"
    assert base["licenses"][0]["license"]["id"] == "Apache-2.0"
    assert base["hashes"] == [{"alg": "SHA-256", "content": BASE_HASH}]
    assert props(base)["minibrain:base_model:content_hash_recorded"] == "true"

    adapter = by_type(bom, "file")[0]
    assert adapter["hashes"] == [{"alg": "SHA-256", "content": adapter_id}]
    assert adapter_id == hashlib.sha256(fake_adapter()).hexdigest()
    assert adapter["mime-type"] == "application/x-tar"

    data = card["training_data"]
    assert snapshot["hashes"] == [{"alg": "SHA-256", "content": data["snapshot_hash"]}]
    assert props(snapshot)["minibrain:snapshot:train_rows"] == "146"
    assert props(snapshot)["minibrain:snapshot:check:personal_data"] == "ok"
    source = by_type(bom, "data")[1]
    assert source["hashes"] == [{"alg": "SHA-256", "content": hashlib.sha256(tickets_csv()).hexdigest()}]
    assert data["sources"][0]["fingerprint"] == source["hashes"][0]["content"]
    assert props(source)["minibrain:source:kind"] == "upload"

    graph = {entry["ref"]: entry["dependsOn"] for entry in bom["dependencies"]}
    assert graph[model["bom-ref"]] == [base["bom-ref"], adapter["bom-ref"], snapshot["bom-ref"]]
    assert graph[snapshot["bom-ref"]] == [source["bom-ref"]]
    refs = [model["bom-ref"]] + [component["bom-ref"] for component in bom["components"]]
    assert sorted(graph) == sorted(refs)


def test_prompt_only_version_has_no_adapter_and_is_valid(harness: Harness) -> None:
    trained_card(harness)
    bom = aibom(harness, 0)
    assert_valid(bom)
    assert by_type(bom, "file") == []
    model = bom["metadata"]["component"]
    assert "approach" not in model["modelCard"]["modelParameters"]
    assert props(model)["minibrain:training:few_shot_examples"] == "4"
    graph = {entry["ref"]: entry["dependsOn"] for entry in bom["dependencies"]}
    assert len(graph[model["bom-ref"]]) == 2


def test_aibom_is_deterministic_and_carries_its_sha256(harness: Harness) -> None:
    trained_card(harness)
    first = harness.client.get(f"{CARD}/1/aibom.json")
    assert first.headers["content-type"] == "application/vnd.cyclonedx+json"
    assert first.headers["content-disposition"] == f'attachment; filename="{SLUG}-v1-aibom.cdx.json"'
    assert first.content == harness.client.get(f"{CARD}/1/aibom.json").content
    bom = first.json()
    sealed = props(bom["metadata"])
    sha256 = sealed["minibrain:aibom:sha256"]
    assert recomputed(bom) == sha256
    assert bom["serialNumber"].startswith(f"urn:uuid:{sha256[:8]}-{sha256[8:12]}-8")
    assert harness.client.post(f"/api/models/{SLUG}/deploy", json={"deployed": False}).status_code == 202
    assert harness.client.get(f"{CARD}/1/aibom.json").content == first.content
    edited = harness.client.put(f"{CARD}/1/card", json={"known_limits": "English tickets only."})
    assert edited.status_code == 200
    after = aibom(harness, 1)
    assert_valid(after)
    assert props(after["metadata"])["minibrain:aibom:sha256"] != sha256
    assert after["serialNumber"] != bom["serialNumber"]
    assert after["metadata"]["component"]["modelCard"]["considerations"]["technicalLimitations"][-1] == (
        "English tickets only."
    )
    assert after["metadata"]["timestamp"] >= bom["metadata"]["timestamp"]


def test_missing_version_is_404(harness: Harness) -> None:
    trained_card(harness)
    assert harness.client.get(f"{CARD}/9/aibom.json").status_code == 404
