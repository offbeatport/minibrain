from sqlalchemy.orm import Session

from minibrain.jobs.queue import enqueue
from minibrain.jobs.specs import eval_params
from minibrain.registry.files import MissingArtifactError
from minibrain.registry.models import Job, JobKind, Minibrain, Snapshot, VersionStatus
from minibrain.registry.service import latest_snapshot


class DomainEffects:
    def on_success(self, session: Session, job: Job) -> None:
        if job.kind == JobKind.PREPARE:
            self.snapshot_built(session, job)
        elif job.kind == JobKind.TRAIN:
            self.trained(session, job)
        elif job.kind == JobKind.EVAL:
            self.evaluated(job)

    def on_failure(self, session: Session, job: Job) -> None:
        if job.version is not None and job.kind in (JobKind.TRAIN, JobKind.EVAL):
            job.version.status = VersionStatus.FAILED

    def on_retry(self, session: Session, job: Job) -> None:
        if job.version is None:
            return
        if job.kind == JobKind.TRAIN:
            job.version.status = VersionStatus.TRAINING
        elif job.kind == JobKind.EVAL:
            job.version.status = VersionStatus.EVALUATING

    def snapshot_built(self, session: Session, job: Job) -> None:
        minibrain = session.get(Minibrain, job.minibrain_id) if job.minibrain_id is not None else None
        result = job.result or {}
        artifact = job.outputs.get("snapshot")
        if minibrain is None or artifact is None:
            raise MissingArtifactError(f"prepare job {job.id} returned no snapshot")
        current = latest_snapshot(minibrain)
        if current is not None and current.hash == result.get("hash"):
            return
        session.add(
            Snapshot(
                minibrain=minibrain,
                hash=str(result["hash"]),
                artifact_id=artifact,
                counts=dict(result["counts"]),
                labels=list(result["labels"]),
            )
        )

    def trained(self, session: Session, job: Job) -> None:
        version = job.version
        adapter = job.outputs.get("adapter")
        if version is None or adapter is None:
            raise MissingArtifactError(f"train job {job.id} returned no adapter")
        version.adapter_artifact_id = adapter
        version.recipe = dict((job.result or {}).get("summary", version.recipe))
        version.status = VersionStatus.EVALUATING
        session.flush()
        enqueue(
            session,
            JobKind.EVAL,
            eval_params(session, version),
            minibrain_id=version.minibrain_id,
            version_id=version.id,
            idempotency_key=f"eval:{version.id}",
        )

    def evaluated(self, job: Job) -> None:
        version = job.version
        if version is None:
            return
        version.metrics = dict((job.result or {}).get("metrics", {}))
        version.status = VersionStatus.READY
        if version.minibrain.current_version is None:
            version.minibrain.current_version = version.number
