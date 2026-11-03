import json
import re
import uuid
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from minibrain.api.card_builder import stamp
from minibrain.api.card_export import digest
from minibrain.api.card_schemas import (
    CardBaseModel,
    CardData,
    CardEvaluation,
    CardRun,
    CardScore,
    CardSource,
    CardTraining,
    ModelCard,
)
from minibrain.models.rules import LICENCES
from minibrain.registry.models import Artifact, AuditEvent, Version

SPEC_VERSION = "1.6"
MEDIA_TYPE = "application/vnd.cyclonedx+json"
SCHEMA = "http://cyclonedx.org/schema/bom-1.6.schema.json"
SHA256_PROPERTY = "minibrain:aibom:sha256"
CANONICAL_FORM_PROPERTY = "minibrain:aibom:canonical_form"
AIBOM_CANONICAL_FORM = (
    "SHA-256 of the UTF-8 bytes of the BOM without serialNumber and metadata.properties, serialised as JSON with "
    "keys sorted, no whitespace and non-ASCII characters kept, as json.dumps(bom, sort_keys=True, "
    "separators=(',', ':'), ensure_ascii=False) writes it; serialNumber is a UUIDv8 made from its first 16 bytes"
)
SPDX_IDS = {"apache-2.0": "Apache-2.0", "mit": "MIT"}
TASKS = {"classify": "text-classification"}
MIME_TYPES = {"tar": "application/x-tar", "file": "application/octet-stream"}
UPLOAD = "upload"
SHA256_HEX = re.compile(r"[0-9a-f]{64}")

Values = list[tuple[str, Any]]


@dataclass(frozen=True)
class Adapter:
    sha256: str
    size: int | None
    packing: str | None


@dataclass(frozen=True)
class Refs:
    version: str
    card: str
    base: str
    snapshot: str
    adapter: str | None


def adapter_of(session: Session, version: Version) -> Adapter | None:
    if version.adapter_artifact_id is None:
        return None
    artifact = session.get(Artifact, version.adapter_artifact_id)
    return Adapter(
        sha256=version.adapter_artifact_id,
        size=artifact.size if artifact is not None else None,
        packing=artifact.packing if artifact is not None else None,
    )


def edited_at(session: Session, target: str) -> str | None:
    query = select(func.max(AuditEvent.at)).where(AuditEvent.action == "version.card", AuditEvent.target == target)
    return stamp(session.scalar(query))


def kept(fields: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in fields.items() if value is not None and value != "" and value != []}


def text(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def props(prefix: str, values: Values) -> list[dict[str, str]]:
    return [
        {"name": f"minibrain:{prefix}{name}", "value": text(value)}
        for name, value in values
        if value is not None and value != ""
    ]


def sha256_hashes(value: str | None) -> list[dict[str, str]]:
    return [{"alg": "SHA-256", "content": value}] if value and SHA256_HEX.fullmatch(value) else []


def serial(sha256: str) -> str:
    value = int(sha256[:32], 16)
    value = (value & ~(0xF << 76)) | (8 << 76)
    value = (value & ~(0x3 << 62)) | (0x2 << 62)
    return f"urn:uuid:{uuid.UUID(int=value)}"


def refs_of(card: ModelCard, adapter: Adapter | None) -> Refs:
    return Refs(
        version=f"minibrain:{card.version.id}",
        card=f"model-card:{card.version.id}",
        base=f"base-model:{card.base_model.key}",
        snapshot=f"snapshot:{card.training_data.snapshot_hash}",
        adapter=f"adapter:{adapter.sha256}" if adapter is not None else None,
    )


def source_ref(source: CardSource) -> str:
    return f"source:{source.table}"


def huggingface_purl(base: CardBaseModel) -> str | None:
    if not base.repo or not base.revision or "/" not in base.repo:
        return None
    owner, name = base.repo.split("/", 1)
    return f"pkg:huggingface/{quote(owner, safe='')}/{quote(name, safe='')}@{quote(base.revision.lower(), safe='')}"


def licences(base: CardBaseModel) -> list[dict[str, Any]]:
    if not base.licence:
        return []
    key = base.licence.strip().lower()
    named = {"id": SPDX_IDS[key]} if key in SPDX_IDS else {"name": base.licence_name or base.licence}
    url = LICENCES[key][2] if key in LICENCES else None
    return [{"license": kept(named | {"acknowledgement": "declared", "url": url})}]


def base_component(base: CardBaseModel, refs: Refs) -> dict[str, Any]:
    values: Values = [
        ("key", base.key),
        ("name", base.name),
        ("content_hash_recorded", base.content_hash_recorded),
        ("licence_use", base.licence_use),
        ("licence_accepted_by", base.licence_accepted_by),
        ("licence_accepted_at", base.licence_accepted_at),
    ]
    return kept(
        {
            "type": "machine-learning-model",
            "bom-ref": refs.base,
            "publisher": base.publisher,
            "name": base.repo or base.key,
            "version": base.revision,
            "hashes": sha256_hashes(base.content_hash),
            "licenses": licences(base),
            "purl": huggingface_purl(base),
            "properties": props("base_model:", values),
        }
    )


def adapter_component(card: ModelCard, adapter: Adapter, refs: Refs) -> dict[str, Any]:
    values: Values = [("artifact_id", adapter.sha256), ("packing", adapter.packing), ("size", adapter.size)]
    return kept(
        {
            "type": "file",
            "mime-type": MIME_TYPES.get(adapter.packing or ""),
            "bom-ref": refs.adapter,
            "name": f"{card.version.slug}-v{card.version.number}-adapter",
            "version": str(card.version.number),
            "description": f"LoRA adapter for {card.base_model.repo or card.base_model.key}",
            "hashes": sha256_hashes(adapter.sha256),
            "properties": props("adapter:", values),
        }
    )


def check_values(data: CardData) -> Values:
    found: Values = []
    for check in data.checks:
        found += [(f"check:{check.check}", check.status), (f"check:{check.check}:detail", check.detail)]
    return found


def dataset_entry(data: CardData) -> dict[str, Any]:
    splits = data.splits
    personal = data.personal_data
    flagged = [personal.detail] if personal is not None and personal.status == "warning" else []
    described = (
        f"{data.snapshot_rows} labelled rows: {splits.train} train, {splits.held_out} held-out, {splits.test} test, "
        f"{splits.few_shot} few-shot"
    )
    return kept(
        {
            "type": "dataset",
            "name": data.dataset_name or data.dataset_slug or "snapshot",
            "description": described,
            "sensitiveData": flagged,
        }
    )


def snapshot_component(data: CardData, refs: Refs) -> dict[str, Any]:
    splits = data.splits
    values: Values = [
        ("dataset", data.dataset_slug),
        ("rows", data.snapshot_rows),
        ("train_rows", splits.train),
        ("held_out_rows", splits.held_out),
        ("test_rows", splits.test),
        ("few_shot_rows", splits.few_shot),
        ("taken_at", data.snapshot_taken_at),
        ("query", data.query),
    ]
    return kept(
        {
            "type": "data",
            "bom-ref": refs.snapshot,
            "name": data.dataset_slug or "snapshot",
            "version": data.snapshot_taken_at,
            "hashes": sha256_hashes(data.snapshot_hash),
            "data": [dataset_entry(data)],
            "properties": props("snapshot:", values + check_values(data)),
        }
    )


def source_component(source: CardSource) -> dict[str, Any]:
    values: Values = [("table", source.table), ("kind", source.kind), ("fingerprint", source.fingerprint)]
    return kept(
        {
            "type": "data",
            "bom-ref": source_ref(source),
            "name": source.name or source.table,
            "hashes": sha256_hashes(source.fingerprint) if source.kind == UPLOAD else [],
            "data": [{"type": "dataset", "name": source.table}],
            "properties": props("source:", values),
        }
    )


def metric(kind: str, value: Any, slice_name: str) -> dict[str, str]:
    return {"type": kind, "value": text(value), "slice": slice_name}


def score_metrics(score: CardScore | None, slice_name: str) -> list[dict[str, str]]:
    if score is None:
        return []
    values = [
        ("accuracy", score.accuracy),
        ("macro-f1", score.macro_f1),
        ("invalid-rate", score.invalid_rate),
        ("examples", score.examples),
    ]
    return [metric(kind, value, slice_name) for kind, value in values]


def label_metrics(evaluation: CardEvaluation) -> list[dict[str, str]]:
    found: list[dict[str, str]] = []
    for label in evaluation.per_label or []:
        values = [
            ("precision", label.precision),
            ("recall", label.recall),
            ("f1", label.f1),
            ("support", label.support),
        ]
        name = f"held-out, label {label.label}"
        found += [metric(kind, value, name) for kind, value in values if value is not None]
    return found


def performance(evaluation: CardEvaluation) -> list[dict[str, str]]:
    latency = [("latency-p50-ms", evaluation.latency_p50_ms), ("latency-p95-ms", evaluation.latency_p95_ms)]
    timed = [metric(kind, value, "held-out") for kind, value in latency if value is not None]
    scores = score_metrics(evaluation.held_out, "held-out") + score_metrics(evaluation.test_set, "test")
    return scores + label_metrics(evaluation) + timed


def architecture(card: ModelCard) -> str:
    base = card.base_model.repo or card.base_model.key
    if card.training.method == "lora":
        return f"LoRA adapter on {base}"
    return f"{base} with the task prompt and {card.training.few_shot_examples or 0} few-shot examples"


def considerations(card: ModelCard) -> dict[str, Any] | None:
    intended = card.use.intended_use.strip()
    known = card.limits.known_limits.strip()
    limits = [limit.text for limit in card.limits.derived] + ([known] if known else [])
    found = kept({"useCases": [intended] if intended else [], "technicalLimitations": limits})
    return found or None


def model_card(card: ModelCard, refs: Refs) -> dict[str, Any]:
    trained = card.training.method == "lora"
    parameters = kept(
        {
            "approach": {"type": "supervised"} if trained else None,
            "task": TASKS.get(card.purpose.task, card.purpose.task),
            "modelArchitecture": architecture(card),
            "datasets": [{"ref": refs.snapshot}],
            "inputs": [{"format": "text"}],
            "outputs": [{"format": "label"}],
        }
    )
    metrics = performance(card.evaluation)
    return kept(
        {
            "bom-ref": refs.card,
            "modelParameters": parameters,
            "quantitativeAnalysis": {"performanceMetrics": metrics} if metrics else None,
            "considerations": considerations(card),
            "properties": [{"name": "minibrain:purpose:label", "value": label} for label in card.purpose.labels],
        }
    )


def run_values(prefix: str, run: CardRun | None) -> Values:
    if run is None:
        return []
    return [
        (f"{prefix}:job", run.job_id),
        (f"{prefix}:started_at", run.started_at),
        (f"{prefix}:finished_at", run.finished_at),
        (f"{prefix}:duration_seconds", run.duration_seconds),
        (f"{prefix}:device", run.device),
        (f"{prefix}:machine", run.machine),
    ]


def training_values(training: CardTraining) -> Values:
    found: Values = [
        ("training:method", training.method),
        ("training:examples", training.examples),
        ("training:few_shot_examples", training.few_shot_examples),
        ("training:train_loss", training.train_loss),
    ]
    if training.recipe is not None:
        found += [(f"recipe:{name}", value) for name, value in training.recipe.model_dump().items()]
    return found + run_values("training", training.run)


def version_values(card: ModelCard) -> Values:
    version = card.version
    identity: Values = [
        ("version:id", version.id),
        ("version:name", version.name),
        ("version:kind", version.kind),
        ("version:status", version.status),
        ("version:created_at", version.created_at),
        ("version:created_by", version.created_by),
        ("use:owner", card.use.owner),
    ]
    scored: Values = [("evaluation:scored", card.evaluation.scored)]
    return identity + training_values(card.training) + scored + run_values("evaluation", card.evaluation.run)


def version_component(card: ModelCard, refs: Refs) -> dict[str, Any]:
    version = card.version
    card_url = f"/api/minibrains/{quote(version.slug, safe='')}/versions/{version.number}/card.json"
    reference = {"type": "model-card", "url": card_url, "comment": "minibrain model card and validation report"}
    return kept(
        {
            "type": "machine-learning-model",
            "bom-ref": refs.version,
            "authors": [{"name": version.created_by}] if version.created_by else [],
            "name": version.slug,
            "version": str(version.number),
            "description": card.purpose.description.strip(),
            "externalReferences": [reference],
            "modelCard": model_card(card, refs),
            "properties": props("", version_values(card)),
        }
    )


def timestamp(card: ModelCard, edited: str | None) -> str:
    moments = [
        card.version.created_at,
        card.training.run.finished_at if card.training.run else None,
        card.evaluation.run.finished_at if card.evaluation.run else None,
        card.base_model.licence_accepted_at,
        edited,
    ]
    return max(moment for moment in moments if moment)


def dependencies(card: ModelCard, refs: Refs) -> list[dict[str, Any]]:
    sources = [source_ref(source) for source in card.training_data.sources]
    adapter = [refs.adapter] if refs.adapter else []
    found = [
        {"ref": refs.version, "dependsOn": [refs.base, *adapter, refs.snapshot]},
        {"ref": refs.base, "dependsOn": []},
    ]
    found += [{"ref": ref, "dependsOn": [refs.base]} for ref in adapter]
    found.append({"ref": refs.snapshot, "dependsOn": sources})
    return found + [{"ref": ref, "dependsOn": []} for ref in sources]


def components(card: ModelCard, adapter: Adapter | None, refs: Refs) -> list[dict[str, Any]]:
    found = [base_component(card.base_model, refs)]
    if adapter is not None:
        found.append(adapter_component(card, adapter, refs))
    found.append(snapshot_component(card.training_data, refs))
    return found + [source_component(source) for source in card.training_data.sources]


def build_aibom(card: ModelCard, adapter: Adapter | None, edited: str | None, tool_version: str) -> dict[str, Any]:
    refs = refs_of(card, adapter)
    tool = {"type": "application", "name": "minibrain", "version": tool_version}
    metadata = {
        "timestamp": timestamp(card, edited),
        "tools": {"components": [tool]},
        "component": version_component(card, refs),
    }
    head: dict[str, Any] = {"$schema": SCHEMA, "bomFormat": "CycloneDX", "specVersion": SPEC_VERSION}
    rest: dict[str, Any] = {"components": components(card, adapter, refs), "dependencies": dependencies(card, refs)}
    sha256 = digest(head | {"version": 1, "metadata": metadata} | rest)
    sealed = metadata | {
        "properties": [
            {"name": SHA256_PROPERTY, "value": sha256},
            {"name": CANONICAL_FORM_PROPERTY, "value": AIBOM_CANONICAL_FORM},
        ]
    }
    return head | {"serialNumber": serial(sha256), "version": 1, "metadata": sealed} | rest


def export_aibom(bom: dict[str, Any]) -> str:
    return json.dumps(bom, indent=2, ensure_ascii=False) + "\n"
