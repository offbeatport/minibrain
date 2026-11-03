from sqlalchemy.orm import Session

from minibrain.jobs.queue import enqueue
from minibrain.jobs.specs import eval_params
from minibrain.models.catalog import apply_sync
from minibrain.models.health import apply_check, apply_repair, set_health
from minibrain.models.registry import apply_catalogue
from minibrain.registry.files import MissingArtifactError
from minibrain.registry.models import (
    CatalogModel,
    CatalogVariant,
    Job,
    JobKind,
    JobStatus,
    Model,
    ModelStatus,
    VersionStatus,
    now,
)
from minibrain.settings import Settings

TRANSFERS = (JobKind.DOWNLOAD, JobKind.IMPORT)


class DomainEffects:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def on_success(self, session: Session, job: Job) -> None:
        if job.kind == JobKind.TRAIN:
            self.trained(session, job)
        elif job.kind == JobKind.EVAL:
            self.evaluated(job)
        elif job.kind in TRANSFERS:
            self.transferred(session, job)
        elif job.kind == JobKind.CATALOG_SYNC:
            apply_sync(session, job.result or {})
        elif job.kind == JobKind.VERIFY:
            self.verified(session, job)
        elif job.kind == JobKind.REPAIR:
            self.repaired(session, job)

    def on_failure(self, session: Session, job: Job) -> None:
        if job.version is not None and job.kind in (JobKind.TRAIN, JobKind.EVAL):
            job.version.status = VersionStatus.FAILED
        model = session.get(Model, job.model_id) if job.model_id else None
        if model is not None and job.kind in TRANSFERS:
            model.status = ModelStatus.CANCELLED if job.status == JobStatus.CANCELLED else ModelStatus.FAILED
            model.error = job.error
            model.updated_at = now()
        if model is not None and job.kind in (JobKind.REPAIR, JobKind.VERIFY):
            model.error = job.error
            model.updated_at = now()

    def on_retry(self, session: Session, job: Job) -> None:
        model = session.get(Model, job.model_id) if job.model_id else None
        if model is not None and job.kind in TRANSFERS:
            model.status = ModelStatus.DOWNLOADING if job.kind == JobKind.DOWNLOAD else ModelStatus.IMPORTING
            model.error = None
            model.updated_at = now()
        if job.version is None:
            return
        if job.kind == JobKind.TRAIN:
            job.version.status = VersionStatus.TRAINING
        elif job.kind == JobKind.EVAL:
            job.version.status = VersionStatus.EVALUATING

    def transferred(self, session: Session, job: Job) -> None:
        model = session.get(Model, job.model_id) if job.model_id else None
        if model is None:
            return
        result = job.result or {}
        model.files = list(result.get("files", model.files))
        model.size_bytes = int(result.get("size_bytes", model.size_bytes))
        variant = session.get(CatalogVariant, result["variant_id"]) if result.get("variant_id") else None
        if job.kind == JobKind.IMPORT and variant is not None:
            entry = session.get(CatalogModel, variant.catalog_id)
            if entry is not None:
                apply_catalogue(model, entry, variant)
        model.verified = job.kind == JobKind.DOWNLOAD or variant is not None
        model.status = ModelStatus.AVAILABLE
        model.error = None
        model.verified_at = now()
        set_health(model, None)

    def verified(self, session: Session, job: Job) -> None:
        model = session.get(Model, job.model_id) if job.model_id else None
        if model is None:
            return
        apply_check(model, list((job.result or {}).get("files", [])))
        model.error = None

    def repaired(self, session: Session, job: Job) -> None:
        model = session.get(Model, job.model_id) if job.model_id else None
        if model is None:
            return
        apply_repair(model, list((job.result or {}).get("files", [])))
        model.status = ModelStatus.AVAILABLE
        model.error = None
        model.updated_at = now()

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
            eval_params(session, self.settings, version),
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
