from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from sqlalchemy import JSON, BigInteger, ForeignKey, Index, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from minibrain.registry.db import Base, UtcDateTime


def now() -> datetime:
    return datetime.now(UTC)


class VersionKind(StrEnum):
    PROMPT = "prompt"
    LORA = "lora"


class VersionStatus(StrEnum):
    TRAINING = "training"
    EVALUATING = "evaluating"
    READY = "ready"
    FAILED = "failed"


class JobKind(StrEnum):
    PREPARE = "prepare"
    TRAIN = "train"
    EVAL = "eval"
    DOWNLOAD = "download"
    IMPORT = "import"
    CATALOG_SYNC = "catalog_sync"


class ModelStatus(StrEnum):
    DOWNLOADING = "downloading"
    IMPORTING = "importing"
    AVAILABLE = "available"
    FAILED = "failed"
    CANCELLED = "cancelled"


class JobStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class AttemptOutcome(StrEnum):
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    LOST = "lost"
    CANCELLED = "cancelled"


ACTIVE_JOB_STATUSES = (JobStatus.QUEUED, JobStatus.RUNNING)
FINAL_JOB_STATUSES = (JobStatus.SUCCEEDED, JobStatus.FAILED, JobStatus.CANCELLED)


class Artifact(Base):
    __tablename__ = "artifacts"

    id: Mapped[str] = mapped_column(primary_key=True)
    kind: Mapped[str]
    packing: Mapped[str]
    name: Mapped[str]
    size: Mapped[int]
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now)


class Minibrain(Base):
    __tablename__ = "minibrains"

    id: Mapped[int] = mapped_column(primary_key=True)
    slug: Mapped[str] = mapped_column(unique=True)
    name: Mapped[str]
    task: Mapped[str]
    base_model: Mapped[str]
    source_file: Mapped[str | None] = mapped_column(default=None)
    source_artifact_id: Mapped[str | None] = mapped_column(ForeignKey("artifacts.id"), default=None)
    input_column: Mapped[str | None] = mapped_column(default=None)
    label_column: Mapped[str | None] = mapped_column(default=None)
    sql: Mapped[str | None] = mapped_column(default=None)
    current_version: Mapped[int | None] = mapped_column(default=None)
    description: Mapped[str] = mapped_column(default="", server_default="")
    tags: Mapped[list[str]] = mapped_column(JSON, default=list, server_default="[]")
    archived_at: Mapped[datetime | None] = mapped_column(UtcDateTime, default=None)
    updated_at: Mapped[datetime | None] = mapped_column(UtcDateTime, default=now)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now)

    snapshots: Mapped[list["Snapshot"]] = relationship(back_populates="minibrain", cascade="all, delete-orphan")
    versions: Mapped[list["Version"]] = relationship(back_populates="minibrain", cascade="all, delete-orphan")
    jobs: Mapped[list["Job"]] = relationship(back_populates="minibrain", cascade="all, delete-orphan")
    keys: Mapped[list["ApiKey"]] = relationship(back_populates="minibrain", cascade="all, delete-orphan")


class Snapshot(Base):
    __tablename__ = "snapshots"

    id: Mapped[int] = mapped_column(primary_key=True)
    minibrain_id: Mapped[int] = mapped_column(ForeignKey("minibrains.id", ondelete="CASCADE"))
    hash: Mapped[str]
    directory: Mapped[str | None] = mapped_column(default=None)
    artifact_id: Mapped[str | None] = mapped_column(ForeignKey("artifacts.id"), default=None)
    counts: Mapped[dict[str, int]] = mapped_column(JSON)
    labels: Mapped[list[str]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now)

    minibrain: Mapped[Minibrain] = relationship(back_populates="snapshots")


class Version(Base):
    __tablename__ = "versions"
    __table_args__ = (UniqueConstraint("minibrain_id", "number"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    minibrain_id: Mapped[int] = mapped_column(ForeignKey("minibrains.id", ondelete="CASCADE"))
    snapshot_id: Mapped[int] = mapped_column(ForeignKey("snapshots.id"))
    number: Mapped[int]
    kind: Mapped[str]
    status: Mapped[str]
    adapter_dir: Mapped[str | None] = mapped_column(default=None)
    adapter_artifact_id: Mapped[str | None] = mapped_column(ForeignKey("artifacts.id"), default=None)
    recipe: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    metrics: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=None)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now)

    minibrain: Mapped[Minibrain] = relationship(back_populates="versions")
    snapshot: Mapped[Snapshot] = relationship()


class Worker(Base):
    __tablename__ = "workers"

    id: Mapped[str] = mapped_column(primary_key=True)
    host: Mapped[str]
    kinds: Mapped[list[str]] = mapped_column(JSON)
    gpus: Mapped[int] = mapped_column(default=0)
    started_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now)
    seen_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now)


class Job(Base):
    __tablename__ = "jobs"
    __table_args__ = (
        Index("ix_jobs_claim", "status", "priority", "id"),
        Index(
            "uq_jobs_active_key",
            "idempotency_key",
            unique=True,
            sqlite_where="status IN ('queued', 'running')",
            postgresql_where="status IN ('queued', 'running')",
        ),
        {"sqlite_autoincrement": True},
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str]
    minibrain_id: Mapped[int | None] = mapped_column(ForeignKey("minibrains.id", ondelete="CASCADE"), default=None)
    version_id: Mapped[int | None] = mapped_column(ForeignKey("versions.id", ondelete="CASCADE"), default=None)
    model_id: Mapped[str | None] = mapped_column(ForeignKey("models.id", ondelete="SET NULL"), default=None)
    params: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    needs_gpu: Mapped[bool] = mapped_column(default=False)
    status: Mapped[str] = mapped_column(default=JobStatus.QUEUED)
    priority: Mapped[int] = mapped_column(default=0)
    attempt: Mapped[int] = mapped_column(default=0)
    max_attempts: Mapped[int] = mapped_column(default=3)
    run_after: Mapped[datetime] = mapped_column(UtcDateTime, default=now)
    lease_owner: Mapped[str | None] = mapped_column(default=None)
    lease_token: Mapped[str | None] = mapped_column(default=None)
    lease_expires_at: Mapped[datetime | None] = mapped_column(UtcDateTime, default=None)
    cancel_requested: Mapped[bool] = mapped_column(default=False)
    idempotency_key: Mapped[str | None] = mapped_column(default=None)
    retry_of: Mapped[int | None] = mapped_column(ForeignKey("jobs.id"), default=None)
    progress: Mapped[float] = mapped_column(default=0.0)
    result: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=None)
    outputs: Mapped[dict[str, str]] = mapped_column(JSON, default=dict)
    error: Mapped[str | None] = mapped_column(default=None)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now)
    started_at: Mapped[datetime | None] = mapped_column(UtcDateTime, default=None)
    finished_at: Mapped[datetime | None] = mapped_column(UtcDateTime, default=None)

    minibrain: Mapped[Minibrain | None] = relationship(back_populates="jobs")
    version: Mapped[Version | None] = relationship()
    attempts: Mapped[list["JobAttempt"]] = relationship(
        back_populates="job", cascade="all, delete-orphan", order_by="JobAttempt.number"
    )


class JobAttempt(Base):
    __tablename__ = "job_attempts"
    __table_args__ = (UniqueConstraint("job_id", "number"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    job_id: Mapped[int] = mapped_column(ForeignKey("jobs.id", ondelete="CASCADE"))
    number: Mapped[int]
    worker: Mapped[str]
    outcome: Mapped[str] = mapped_column(default=AttemptOutcome.RUNNING)
    error: Mapped[str | None] = mapped_column(default=None)
    retryable: Mapped[bool | None] = mapped_column(default=None)
    log_artifact_id: Mapped[str | None] = mapped_column(ForeignKey("artifacts.id"), default=None)
    started_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now)
    finished_at: Mapped[datetime | None] = mapped_column(UtcDateTime, default=None)

    job: Mapped[Job] = relationship(back_populates="attempts")


class JobEvent(Base):
    __tablename__ = "job_events"
    __table_args__ = (Index("ix_job_events_job", "job_id", "id"), {"sqlite_autoincrement": True})

    id: Mapped[int] = mapped_column(primary_key=True)
    job_id: Mapped[int] = mapped_column(ForeignKey("jobs.id", ondelete="CASCADE"))
    attempt: Mapped[int]
    kind: Mapped[str]
    message: Mapped[str] = mapped_column(default="")
    data: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=None)
    at: Mapped[datetime] = mapped_column(UtcDateTime, default=now)


class ApiKey(Base):
    __tablename__ = "api_keys"

    id: Mapped[int] = mapped_column(primary_key=True)
    minibrain_id: Mapped[int | None] = mapped_column(ForeignKey("minibrains.id", ondelete="CASCADE"), default=None)
    model_id: Mapped[str | None] = mapped_column(ForeignKey("models.id", ondelete="CASCADE"), default=None)
    name: Mapped[str]
    prefix: Mapped[str]
    digest: Mapped[str] = mapped_column(unique=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now)
    last_used_at: Mapped[datetime | None] = mapped_column(UtcDateTime, default=None)

    minibrain: Mapped[Minibrain | None] = relationship(back_populates="keys")


class RequestLog(Base):
    __tablename__ = "request_logs"
    __table_args__ = (Index("ix_request_logs_minibrain", "minibrain_id", "id"), {"sqlite_autoincrement": True})

    id: Mapped[int] = mapped_column(primary_key=True)
    at: Mapped[datetime] = mapped_column(UtcDateTime)
    key_id: Mapped[int | None] = mapped_column(ForeignKey("api_keys.id", ondelete="SET NULL"), default=None)
    minibrain_id: Mapped[int | None] = mapped_column(ForeignKey("minibrains.id", ondelete="CASCADE"), default=None)
    model: Mapped[str]
    version: Mapped[int | None] = mapped_column(default=None)
    status: Mapped[int]
    latency_ms: Mapped[float]
    prompt_tokens: Mapped[int] = mapped_column(default=0)
    completion_tokens: Mapped[int] = mapped_column(default=0)


class CatalogModel(Base):
    __tablename__ = "catalog_models"

    id: Mapped[str] = mapped_column(primary_key=True)
    name: Mapped[str]
    description: Mapped[str]
    provider: Mapped[str]
    repo: Mapped[str]
    capabilities: Mapped[list[str]] = mapped_column(JSON, default=list)
    license: Mapped[str]
    license_name: Mapped[str]
    license_summary: Mapped[str]
    license_url: Mapped[str]
    gated: Mapped[bool] = mapped_column(default=False)
    recommended: Mapped[bool] = mapped_column(default=False)
    recommendation: Mapped[str | None] = mapped_column(default=None)
    trainable: Mapped[bool] = mapped_column(default=False)
    template_kwargs: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    stop_tokens: Mapped[list[str]] = mapped_column(JSON, default=list)
    popularity: Mapped[int] = mapped_column(default=0)
    position: Mapped[int] = mapped_column(default=0)
    synced_at: Mapped[datetime | None] = mapped_column(UtcDateTime, default=None)

    variants: Mapped[list["CatalogVariant"]] = relationship(
        back_populates="model", cascade="all, delete-orphan", order_by="CatalogVariant.position"
    )


class CatalogVariant(Base):
    __tablename__ = "catalog_variants"

    id: Mapped[str] = mapped_column(primary_key=True)
    catalog_id: Mapped[str] = mapped_column(ForeignKey("catalog_models.id", ondelete="CASCADE"))
    position: Mapped[int] = mapped_column(default=0)
    label: Mapped[str]
    format: Mapped[str]
    precision: Mapped[str]
    repo: Mapped[str]
    revision: Mapped[str]
    files: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    size_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    weights_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    runtimes: Mapped[list[str]] = mapped_column(JSON, default=list)
    requires: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    latest_revision: Mapped[str | None] = mapped_column(default=None)

    model: Mapped[CatalogModel] = relationship(back_populates="variants")


class Model(Base):
    __tablename__ = "models"

    id: Mapped[str] = mapped_column(primary_key=True)
    source: Mapped[str]
    catalog_id: Mapped[str | None] = mapped_column(ForeignKey("catalog_models.id", ondelete="SET NULL"), default=None)
    variant_id: Mapped[str | None] = mapped_column(ForeignKey("catalog_variants.id", ondelete="SET NULL"), default=None)
    name: Mapped[str]
    description: Mapped[str] = mapped_column(default="")
    tags: Mapped[list[str]] = mapped_column(JSON, default=list)
    repo: Mapped[str | None] = mapped_column(default=None)
    revision: Mapped[str | None] = mapped_column(default=None)
    source_path: Mapped[str | None] = mapped_column(default=None)
    files: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    size_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    status: Mapped[str]
    error: Mapped[str | None] = mapped_column(default=None)
    trainable: Mapped[bool] = mapped_column(default=False)
    template_kwargs: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    stop_tokens: Mapped[list[str]] = mapped_column(JSON, default=list)
    license: Mapped[str | None] = mapped_column(default=None)
    license_ack_by: Mapped[str | None] = mapped_column(default=None)
    license_ack_at: Mapped[datetime | None] = mapped_column(UtcDateTime, default=None)
    deployed: Mapped[bool] = mapped_column(default=False)
    archived_at: Mapped[datetime | None] = mapped_column(UtcDateTime, default=None)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now)

    variant: Mapped[CatalogVariant | None] = relationship()


class Setting(Base):
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(primary_key=True)
    value: Mapped[Any] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now)
