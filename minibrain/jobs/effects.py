from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.jobs.queue import enqueue
from minibrain.jobs.specs import eval_params, judge_params
from minibrain.models.catalog import apply_sync
from minibrain.models.copies import FOLDER
from minibrain.models.health import apply_check, apply_repair, set_health
from minibrain.models.registry import apply_catalogue
from minibrain.registry.files import MissingArtifactError, store_for
from minibrain.registry.models import (
    BaseModel,
    BaseModelStatus,
    CatalogModel,
    CatalogVariant,
    Job,
    JobKind,
    JobStatus,
    JudgeScore,
    Model,
    Version,
    VersionKind,
    VersionStatus,
    now,
)
from minibrain.settings import Settings
from minibrain.tasks.judge import REASON_CHARACTERS, judge_of, pending_items
from minibrain.tasks.service import graded, graders_of, judge_keys, judge_scores, split_examples

TRANSFERS = (JobKind.DOWNLOAD, JobKind.IMPORT)


class DomainEffects:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def on_success(self, session: Session, job: Job) -> None:
        if job.kind == JobKind.TRAIN:
            self.trained(session, job)
        elif job.kind == JobKind.EVAL:
            self.evaluated(session, job)
        elif job.kind == JobKind.JUDGE:
            self.judged(session, job)
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
        if job.version is not None and job.kind == JobKind.JUDGE:
            job.version.status = VersionStatus.READY
        model = session.get(BaseModel, job.base_model_id) if job.base_model_id else None
        if model is not None and job.kind in TRANSFERS:
            model.status = BaseModelStatus.CANCELLED if job.status == JobStatus.CANCELLED else BaseModelStatus.FAILED
            model.error = job.error
            model.updated_at = now()
        if model is not None and job.kind in (JobKind.REPAIR, JobKind.VERIFY):
            model.error = job.error
            model.updated_at = now()

    def on_retry(self, session: Session, job: Job) -> None:
        model = session.get(BaseModel, job.base_model_id) if job.base_model_id else None
        if model is not None and job.kind in TRANSFERS:
            model.status = BaseModelStatus.DOWNLOADING if job.kind == JobKind.DOWNLOAD else BaseModelStatus.IMPORTING
            model.error = None
            model.updated_at = now()
        if job.version is None:
            return
        if job.kind == JobKind.TRAIN:
            job.version.status = VersionStatus.TRAINING
        elif job.kind in (JobKind.EVAL, JobKind.JUDGE):
            job.version.status = VersionStatus.EVALUATING

    def transferred(self, session: Session, job: Job) -> None:
        model = session.get(BaseModel, job.base_model_id) if job.base_model_id else None
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
        model.store = str(job.params.get("store") or FOLDER)
        model.status = BaseModelStatus.AVAILABLE
        model.error = None
        model.verified_at = now()
        model.last_used_at = now()
        set_health(model, None)
        self.score_waiting(session, model.id)

    def score_waiting(self, session: Session, base: str) -> None:
        waiting = session.scalars(
            select(Version)
            .join(Model)
            .where(
                Model.base_model == base,
                Version.kind == VersionKind.PROMPT,
                Version.status == VersionStatus.READY,
                Version.metrics.is_(None),
                Version.dataset_version_id.is_not(None),
            )
        )
        for version in waiting:
            if version.dataset_version is None or not version.dataset_version.counts:
                continue
            version.status = VersionStatus.EVALUATING
            session.flush()
            params = eval_params(session, self.settings, version)
            enqueue(session, JobKind.EVAL, params, version.model_id, version.id, f"eval:{version.id}")

    def verified(self, session: Session, job: Job) -> None:
        model = session.get(BaseModel, job.base_model_id) if job.base_model_id else None
        if model is None:
            return
        apply_check(model, list((job.result or {}).get("files", [])))
        model.error = None

    def repaired(self, session: Session, job: Job) -> None:
        model = session.get(BaseModel, job.base_model_id) if job.base_model_id else None
        if model is None:
            return
        apply_repair(model, list((job.result or {}).get("files", [])))
        model.store = str(job.params.get("store") or model.store)
        model.status = BaseModelStatus.AVAILABLE
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
            model_id=version.model_id,
            version_id=version.id,
            idempotency_key=f"eval:{version.id}",
        )

    def evaluated(self, session: Session, job: Job) -> None:
        version = job.version
        if version is None:
            return
        result = job.result or {}
        answers = result.get("answers") or {}
        store = store_for(self.settings)
        version.metrics = dict(result.get("metrics", {})) | graded(session, store, version, answers)
        examples = split_examples(session, store, version)
        judge = judge_of(graders_of(version, judge_scores(session, judge_keys(version, examples, answers))))
        items = [
            item
            for name, rows in examples.items()
            for item in (pending_items(judge, rows, answers.get(name, [])) if judge is not None else [])
        ]
        if judge is None or not items:
            version.status = VersionStatus.READY
            return
        unique = list({item.key: item for item in items}.values())
        params = judge_params(session, self.settings, version, judge, unique) | {"eval_job": job.id}
        enqueue(session, JobKind.JUDGE, params, version.model_id, version.id, f"judge:{version.id}:{job.id}")

    def judged(self, session: Session, job: Job) -> None:
        version = job.version
        scores = dict((job.result or {}).get("scores") or {})
        reasons = dict((job.result or {}).get("reasons") or {})
        judge, revision = str(job.params.get("judge")), str(job.params.get("judge_version") or "")
        for key, value in scores.items():
            if session.get(JudgeScore, key) is None:
                reason = str(reasons[key])[:REASON_CHARACTERS] if reasons.get(key) else None
                session.add(JudgeScore(key=key, score=float(value), judge=judge, judge_version=revision, reason=reason))
        session.flush()
        source = session.get(Job, job.params.get("eval_job"))
        if version is None or source is None:
            return
        answers = (source.result or {}).get("answers") or {}
        version.metrics = dict(version.metrics or {}) | graded(session, store_for(self.settings), version, answers)
        version.status = VersionStatus.READY
