import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session, object_session

from minibrain.artifacts import ArtifactStore
from minibrain.jobs.queue import JobStateError
from minibrain.registry.models import (
    ACTIVE_JOB_STATUSES,
    Artifact,
    DatasetVersion,
    Job,
    JobAttempt,
    JobEvent,
    JobKind,
    JobStatus,
    Source,
    Version,
    VersionStatus,
)

BUILDS = (JobKind.TRAIN, JobKind.EVAL, JobKind.JUDGE)
ENDED_BADLY = (JobStatus.FAILED, JobStatus.CANCELLED)
REFERENCES = (
    JobAttempt.log_artifact_id,
    Source.artifact_id,
    DatasetVersion.artifact_id,
    Version.adapter_artifact_id,
)

Refusal = Literal["not_found", "in_use", "active", "state"]


class DeleteRefused(JobStateError):
    def __init__(self, message: str, reason: Refusal) -> None:
        super().__init__(message)
        self.reason: Refusal = reason


@dataclass
class Leftovers:
    removed: bool = False
    artifacts: set[str] = field(default_factory=set)
    folders: list[Path] = field(default_factory=list)

    def merge(self, other: "Leftovers") -> None:
        self.artifacts |= other.artifacts
        self.folders += other.folders

    def clear(self, store: ArtifactStore) -> None:
        for artifact_id in sorted(self.artifacts):
            store.delete(artifact_id)
        for folder in self.folders:
            shutil.rmtree(folder, ignore_errors=True)


def used_by(version: Version) -> str:
    if version.status == VersionStatus.DELETING:
        return f"Used by {version.model.name} v{version.number}, which is being deleted. Try again once it is gone."
    return f"Used by {version.model.name} v{version.number}. Delete the version first."


def copied_into(job: Job) -> Version | None:
    session = object_session(job)
    if session is None or job.kind != JobKind.TRAIN:
        return None
    copies = session.scalars(select(Version).where(Version.duplicated_from.is_not(None)).order_by(Version.id))
    return next((copy for copy in copies if (copy.duplicated_from or {}).get("job") == job.id), None)


def kept_by(job: Job) -> str | None:
    if job.status in ACTIVE_JOB_STATUSES or job.status in ENDED_BADLY or job.kind not in BUILDS:
        return None
    holder = job.version or copied_into(job)
    return used_by(holder) if holder is not None else None


def active_refusal(job: Job) -> str:
    return f"Job #{job.id} is {job.status}; cancel it first"


def referenced(session: Session, artifact_id: str) -> bool:
    return any(
        session.scalar(select(column).where(column == artifact_id).limit(1)) is not None for column in REFERENCES
    )


def remove_job(session: Session, work: Path, job: Job) -> Leftovers:
    logs = {attempt.log_artifact_id for attempt in job.attempts if attempt.log_artifact_id}
    session.execute(update(Job).where(Job.retry_of == job.id).values(retry_of=None))
    session.execute(delete(JobEvent).where(JobEvent.job_id == job.id))
    session.delete(job)
    session.flush()
    leftovers = Leftovers(removed=True, folders=[work / f"job-{job.id}"])
    for artifact_id in logs:
        if referenced(session, artifact_id):
            continue
        found = session.get(Artifact, artifact_id)
        if found is not None:
            session.delete(found)
        leftovers.artifacts.add(artifact_id)
    session.flush()
    return leftovers
