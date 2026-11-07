from copy import deepcopy
from typing import Any

from sqlalchemy.orm import Session

from minibrain.registry.models import JobKind, JobStatus, Model, Version, VersionStatus
from minibrain.registry.service import create_model
from minibrain.tasks.service import checked_contract, next_version_number, version_contract

SETTINGS = (
    "contract",
    "instructions",
    "graders",
    "promotion",
    "description",
    "tags",
    "judge_model",
    "safety",
    "labels_dismissed",
)


def source_version(model: Model) -> Version | None:
    ready = [version for version in model.versions if version.status == VersionStatus.READY]
    live = next((version for version in ready if version.number == model.current_version), None)
    return live or max(ready, key=lambda version: version.number, default=None)


def training_job(version: Version) -> int | None:
    jobs = [
        job
        for job in version.model.jobs
        if job.version_id == version.id and job.kind == JobKind.TRAIN and job.status == JobStatus.SUCCEEDED
    ]
    if jobs:
        return max(job.id for job in jobs)
    return (version.duplicated_from or {}).get("job")


def provenance(source: Model, version: Version) -> dict[str, Any]:
    return {"slug": source.slug, "name": source.name, "number": version.number, "job": training_job(version)}


def duplicate_model(session: Session, source: Model, name: str) -> Model:
    model = create_model(session, name, source.preset, source.base_model)
    for field in SETTINGS:
        setattr(model, field, deepcopy(getattr(source, field)))
    model.dataset = source.dataset
    return model


def copied_version(session: Session, model: Model, source: Model, version: Version) -> Version:
    copy = Version(
        model=model,
        dataset_version=version.dataset_version,
        number=next_version_number(model),
        kind=version.kind,
        status=VersionStatus.READY,
        contract=deepcopy(version.contract),
        contract_number=checked_contract(model, version_contract(version), breaking=True),
        instructions=version.instructions,
        shots=deepcopy(version.shots or []),
        graders=deepcopy(version.graders or []),
        adapter_artifact_id=version.adapter_artifact_id,
        base_hash=version.base_hash,
        recipe=deepcopy(version.recipe or {}),
        metrics=deepcopy(version.metrics),
        intended_use=version.intended_use,
        known_limits=version.known_limits,
        duplicated_from=provenance(source, version),
    )
    session.add(copy)
    session.flush()
    return copy
