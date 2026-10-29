from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session, sessionmaker

from minibrain.base_models import BaseModelSpec, base_model
from minibrain.registry.models import Job, Version, VersionStatus


@dataclass(frozen=True)
class JobContext:
    job_id: int
    version_id: int
    version_kind: str
    slug: str
    number: int
    spec: BaseModelSpec
    snapshot_dir: Path
    adapter_dir: Path | None
    recipe: dict[str, Any]


def load_context(sessions: sessionmaker[Session], job_id: int) -> JobContext:
    with sessions() as session:
        job = session.get(Job, job_id)
        if job is None:
            raise LookupError(f"job {job_id} not found")
        version = job.version
        return JobContext(
            job_id=job.id,
            version_id=version.id,
            version_kind=version.kind,
            slug=job.minibrain.slug,
            number=version.number,
            spec=base_model(job.minibrain.base_model),
            snapshot_dir=Path(version.snapshot.directory),
            adapter_dir=Path(version.adapter_dir) if version.adapter_dir else None,
            recipe=dict(version.recipe),
        )


def set_progress(sessions: sessionmaker[Session], job_id: int, progress: float) -> None:
    with sessions() as session:
        job = session.get(Job, job_id)
        if job is not None:
            job.progress = max(0.0, min(progress, 1.0))
            session.commit()


def update_version(
    sessions: sessionmaker[Session],
    version_id: int,
    recipe: dict[str, Any] | None = None,
    metrics: dict[str, Any] | None = None,
    status: VersionStatus | None = None,
) -> None:
    with sessions() as session:
        version = session.get(Version, version_id)
        if version is None:
            return
        if recipe is not None:
            version.recipe = recipe
        if metrics is not None:
            version.metrics = metrics
        if status is not None:
            version.status = status
        session.commit()
