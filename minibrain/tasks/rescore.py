from typing import Any

from sqlalchemy.orm import Session

from minibrain.jobs.queue import enqueue
from minibrain.jobs.specs import eval_params
from minibrain.models.registry import base_readiness
from minibrain.registry.models import Job, JobKind, Model, Version, VersionStatus
from minibrain.registry.service import ConflictError
from minibrain.settings import Settings
from minibrain.tasks.service import model_graders, told, version_contract

RESCORE = "rescore"
PENDING = (VersionStatus.TRAINING, VersionStatus.EVALUATING)


def graders_for(session: Session, model: Model, version: Version) -> list[dict[str, Any]] | None:
    try:
        configs = model_graders(session, model, version_contract(version))
    except ConflictError:
        return None
    return [told(config, version.instructions or "") for config in configs]


def scorable(session: Session, version: Version) -> bool:
    data = version.dataset_version
    return (
        version.status == VersionStatus.READY
        and version.metrics is not None
        and data is not None
        and bool(data.counts)
        and base_readiness(session, version.base_model) == "ready"
    )


def rescore(session: Session, settings: Settings, model: Model) -> list[Job]:
    jobs: list[Job] = []
    for version in sorted(model.versions, key=lambda item: item.number):
        graders = graders_for(session, model, version)
        if graders is None:
            continue
        if version.status in PENDING:
            version.graders = graders
            continue
        if not scorable(session, version):
            continue
        params = eval_params(session, settings, version) | {RESCORE: graders}
        jobs.append(enqueue(session, JobKind.EVAL, params, model.id, version.id, f"rescore:{version.id}"))
    return jobs
