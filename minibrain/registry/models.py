from contextvars import ContextVar
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from sqlalchemy import JSON, BigInteger, Column, ForeignKey, Index, Table, UniqueConstraint, false
from sqlalchemy.orm import Mapped, mapped_column, relationship

from minibrain.registry.db import Base, UtcDateTime

PEER_ADDRESS: ContextVar[str | None] = ContextVar("peer_address", default=None)
SYSTEM_ACTOR = "system"


def now() -> datetime:
    return datetime.now(UTC)


def peer_address() -> str | None:
    return PEER_ADDRESS.get()


class VersionKind(StrEnum):
    PROMPT = "prompt"
    LORA = "lora"


class VersionStatus(StrEnum):
    TRAINING = "training"
    EVALUATING = "evaluating"
    READY = "ready"
    FAILED = "failed"


class FeedbackStatus(StrEnum):
    PENDING = "pending"
    ACCEPTED = "accepted"
    REJECTED = "rejected"


class JobKind(StrEnum):
    PREPARE = "prepare"
    TRAIN = "train"
    EVAL = "eval"
    DOWNLOAD = "download"
    IMPORT = "import"
    CATALOG_SYNC = "catalog_sync"
    VERIFY = "verify"
    REPAIR = "repair"


class ModelStatus(StrEnum):
    DOWNLOADING = "downloading"
    IMPORTING = "importing"
    AVAILABLE = "available"
    FAILED = "failed"
    CANCELLED = "cancelled"
    EVICTED = "evicted"


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


dataset_sources = Table(
    "dataset_sources",
    Base.metadata,
    Column("dataset_id", ForeignKey("datasets.id", ondelete="CASCADE"), primary_key=True),
    Column("source_id", ForeignKey("sources.id"), primary_key=True),
)


class Source(Base):
    __tablename__ = "sources"
    __table_args__ = ({"sqlite_autoincrement": True},)

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str]
    filename: Mapped[str]
    table_name: Mapped[str] = mapped_column(unique=True)
    kind: Mapped[str] = mapped_column(default="upload", server_default="upload")
    path: Mapped[str | None] = mapped_column(default=None)
    format: Mapped[str | None] = mapped_column(default=None)
    artifact_id: Mapped[str | None] = mapped_column(ForeignKey("artifacts.id"), default=None)
    connection_id: Mapped[int | None] = mapped_column(ForeignKey("connections.id"), default=None)
    query: Mapped[str | None] = mapped_column(default=None)
    change_column: Mapped[str | None] = mapped_column(default=None)
    size: Mapped[int] = mapped_column(BigInteger, default=0)
    description: Mapped[str | None] = mapped_column(default=None)
    tags: Mapped[list[str] | None] = mapped_column(JSON, default=None)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now)

    connection: Mapped["Connection | None"] = relationship(back_populates="sources")
    datasets: Mapped[list["Dataset"]] = relationship(
        secondary=dataset_sources, back_populates="sources", order_by="Dataset.name"
    )


class Connection(Base):
    __tablename__ = "connections"
    __table_args__ = ({"sqlite_autoincrement": True},)

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(unique=True)
    kind: Mapped[str]
    config: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    secret: Mapped[str | None] = mapped_column(default=None)
    secret_ref: Mapped[dict[str, str] | None] = mapped_column(JSON, default=None)
    origin: Mapped[str] = mapped_column(default="ui", server_default="ui")
    problem: Mapped[str | None] = mapped_column(default=None)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now)

    sources: Mapped[list[Source]] = relationship(back_populates="connection", order_by="Source.name")


class DatasetFolder(Base):
    __tablename__ = "dataset_folders"
    __table_args__ = ({"sqlite_autoincrement": True},)

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str]
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("dataset_folders.id"), default=None)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now)


class Dataset(Base):
    __tablename__ = "datasets"
    __table_args__ = ({"sqlite_autoincrement": True},)

    id: Mapped[int] = mapped_column(primary_key=True)
    slug: Mapped[str] = mapped_column(unique=True)
    name: Mapped[str]
    source_id: Mapped[int | None] = mapped_column(ForeignKey("sources.id"), default=None)
    folder_id: Mapped[int | None] = mapped_column(
        ForeignKey("dataset_folders.id", ondelete="SET NULL", name="fk_datasets_folder"), default=None
    )
    input_column: Mapped[str | None] = mapped_column(default=None)
    label_column: Mapped[str | None] = mapped_column(default=None)
    sql: Mapped[str | None] = mapped_column(default=None)
    description: Mapped[str | None] = mapped_column(default=None)
    tags: Mapped[list[str] | None] = mapped_column(JSON, default=None)
    dismissed: Mapped[dict[str, str] | None] = mapped_column(JSON, default=None)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now)

    source: Mapped[Source | None] = relationship()
    sources: Mapped[list[Source]] = relationship(
        secondary=dataset_sources, back_populates="datasets", order_by="Source.name"
    )
    minibrains: Mapped[list["Minibrain"]] = relationship(back_populates="dataset")
    snapshots: Mapped[list["Snapshot"]] = relationship(back_populates="dataset", order_by="Snapshot.id")


class Minibrain(Base):
    __tablename__ = "minibrains"
    __table_args__ = ({"sqlite_autoincrement": True},)

    id: Mapped[int] = mapped_column(primary_key=True)
    slug: Mapped[str] = mapped_column(unique=True)
    name: Mapped[str]
    task: Mapped[str]
    base_model: Mapped[str]
    dataset_id: Mapped[int | None] = mapped_column(ForeignKey("datasets.id", ondelete="SET NULL"), default=None)
    snapshot_id: Mapped[int | None] = mapped_column(
        ForeignKey("snapshots.id", ondelete="SET NULL", use_alter=True), default=None
    )
    current_version: Mapped[int | None] = mapped_column(default=None)
    deployed: Mapped[bool] = mapped_column(default=False, server_default=false())
    last_version: Mapped[int] = mapped_column(default=-1, server_default="-1")
    description: Mapped[str] = mapped_column(default="", server_default="")
    tags: Mapped[list[str]] = mapped_column(JSON, default=list, server_default="[]")
    updated_at: Mapped[datetime | None] = mapped_column(UtcDateTime, default=now)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now)

    dataset: Mapped["Dataset | None"] = relationship(back_populates="minibrains")
    snapshot: Mapped["Snapshot | None"] = relationship(foreign_keys=[snapshot_id], post_update=True)
    snapshots: Mapped[list["Snapshot"]] = relationship(
        back_populates="minibrain", cascade="all, delete-orphan", foreign_keys="Snapshot.minibrain_id"
    )
    versions: Mapped[list["Version"]] = relationship(back_populates="minibrain", cascade="all, delete-orphan")
    jobs: Mapped[list["Job"]] = relationship(back_populates="minibrain", cascade="all, delete-orphan")
    key_scopes: Mapped[list["KeyScope"]] = relationship(back_populates="minibrain", cascade="all, delete-orphan")


class Snapshot(Base):
    __tablename__ = "snapshots"
    __table_args__ = (
        Index("uq_snapshots_dataset_hash", "dataset_id", "hash", unique=True),
        {"sqlite_autoincrement": True},
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    minibrain_id: Mapped[int | None] = mapped_column(ForeignKey("minibrains.id", ondelete="CASCADE"), default=None)
    dataset_id: Mapped[int | None] = mapped_column(ForeignKey("datasets.id", ondelete="SET NULL"), default=None)
    hash: Mapped[str]
    directory: Mapped[str | None] = mapped_column(default=None)
    artifact_id: Mapped[str | None] = mapped_column(ForeignKey("artifacts.id"), default=None)
    counts: Mapped[dict[str, int]] = mapped_column(JSON)
    labels: Mapped[list[str]] = mapped_column(JSON)
    rows: Mapped[int] = mapped_column(default=0, server_default="0")
    size: Mapped[int] = mapped_column(BigInteger, default=0, server_default="0")
    fingerprints: Mapped[dict[str, str] | None] = mapped_column(JSON, default=None)
    sql: Mapped[str | None] = mapped_column(default=None)
    saved: Mapped[bool] = mapped_column(default=False, server_default=false())
    checks: Mapped[list[dict[str, Any]] | None] = mapped_column(JSON, default=None)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now)
    taken_at: Mapped[datetime | None] = mapped_column(UtcDateTime, default=None)
    feedback_rows: Mapped[int] = mapped_column(default=0, server_default="0")

    minibrain: Mapped[Minibrain | None] = relationship(back_populates="snapshots", foreign_keys=[minibrain_id])
    dataset: Mapped["Dataset | None"] = relationship(back_populates="snapshots")
    versions: Mapped[list["Version"]] = relationship(back_populates="snapshot")


class Version(Base):
    __tablename__ = "versions"
    __table_args__ = (UniqueConstraint("minibrain_id", "number"), {"sqlite_autoincrement": True})

    id: Mapped[int] = mapped_column(primary_key=True)
    minibrain_id: Mapped[int] = mapped_column(ForeignKey("minibrains.id", ondelete="CASCADE"))
    snapshot_id: Mapped[int] = mapped_column(ForeignKey("snapshots.id"))
    number: Mapped[int]
    kind: Mapped[str]
    status: Mapped[str]
    adapter_dir: Mapped[str | None] = mapped_column(default=None)
    adapter_artifact_id: Mapped[str | None] = mapped_column(ForeignKey("artifacts.id"), default=None)
    base_hash: Mapped[str | None] = mapped_column(default=None)
    recipe: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    metrics: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=None)
    intended_use: Mapped[str | None] = mapped_column(default=None)
    known_limits: Mapped[str | None] = mapped_column(default=None)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now)

    minibrain: Mapped[Minibrain] = relationship(back_populates="versions")
    snapshot: Mapped[Snapshot] = relationship(back_populates="versions")


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
        Index("ix_jobs_kind", "kind", "id"),
        Index("ix_jobs_minibrain", "minibrain_id", "id"),
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
    error_code: Mapped[str | None] = mapped_column(default=None)
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
    __table_args__ = (UniqueConstraint("job_id", "number"), {"sqlite_autoincrement": True})

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
    __table_args__ = ({"sqlite_autoincrement": True},)

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str]
    prefix: Mapped[str]
    digest: Mapped[str] = mapped_column(unique=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now)
    last_used_at: Mapped[datetime | None] = mapped_column(UtcDateTime, default=None)
    expires_at: Mapped[datetime | None] = mapped_column(UtcDateTime, default=None)

    scopes: Mapped[list["KeyScope"]] = relationship(
        back_populates="key", cascade="all, delete-orphan", order_by="KeyScope.id"
    )


class KeyScope(Base):
    __tablename__ = "api_key_scopes"
    __table_args__ = (UniqueConstraint("key_id", "minibrain_id", "model_id"), {"sqlite_autoincrement": True})

    id: Mapped[int] = mapped_column(primary_key=True)
    key_id: Mapped[int] = mapped_column(ForeignKey("api_keys.id", ondelete="CASCADE"))
    minibrain_id: Mapped[int | None] = mapped_column(ForeignKey("minibrains.id", ondelete="CASCADE"), default=None)
    model_id: Mapped[str | None] = mapped_column(ForeignKey("models.id", ondelete="CASCADE"), default=None)

    key: Mapped[ApiKey] = relationship(back_populates="scopes")
    minibrain: Mapped[Minibrain | None] = relationship(back_populates="key_scopes")


class RequestLog(Base):
    __tablename__ = "request_logs"
    __table_args__ = (
        Index("ix_request_logs_minibrain", "minibrain_id", "id"),
        Index("ix_request_logs_response", "response_id"),
        {"sqlite_autoincrement": True},
    )

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
    response_id: Mapped[str | None] = mapped_column(default=None)
    input: Mapped[str | None] = mapped_column(default=None)
    output: Mapped[str | None] = mapped_column(default=None)


class Feedback(Base):
    __tablename__ = "feedback"
    __table_args__ = (
        Index("ix_feedback_queue", "priority", "id"),
        Index("ix_feedback_input", "minibrain_id", "input_key"),
        Index("ix_feedback_response", "response_id"),
        {"sqlite_autoincrement": True},
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    minibrain_id: Mapped[int] = mapped_column(ForeignKey("minibrains.id", ondelete="CASCADE"))
    version: Mapped[int | None] = mapped_column(default=None)
    response_id: Mapped[str | None] = mapped_column(default=None)
    origin: Mapped[str]
    key_id: Mapped[int | None] = mapped_column(ForeignKey("api_keys.id", ondelete="SET NULL"), default=None)
    rating: Mapped[str]
    input: Mapped[str]
    input_key: Mapped[str]
    output: Mapped[str | None] = mapped_column(default=None)
    correction: Mapped[str | None] = mapped_column(default=None)
    comment: Mapped[str | None] = mapped_column(default=None)
    status: Mapped[str] = mapped_column(default=FeedbackStatus.PENDING)
    label: Mapped[str | None] = mapped_column(default=None)
    priority: Mapped[int] = mapped_column(default=1)
    assignee: Mapped[str | None] = mapped_column(default=None)
    reviewed_by: Mapped[str | None] = mapped_column(default=None)
    reviewed_at: Mapped[datetime | None] = mapped_column(UtcDateTime, default=None)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now)

    minibrain: Mapped[Minibrain] = relationship()


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
    template_kwargs: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    stop_tokens: Mapped[list[str]] = mapped_column(JSON, default=list)
    popularity: Mapped[int] = mapped_column(default=0)
    position: Mapped[int] = mapped_column(default=0)
    synced_at: Mapped[datetime | None] = mapped_column(UtcDateTime, default=None)
    family: Mapped[str] = mapped_column(default="", server_default="")
    generation: Mapped[str] = mapped_column(default="", server_default="")
    architecture: Mapped[str] = mapped_column(default="", server_default="")
    tier: Mapped[str] = mapped_column(default="S", server_default="S")
    params_b: Mapped[float] = mapped_column(default=0.0, server_default="0")
    moe: Mapped[bool] = mapped_column(default=False, server_default=false())
    superseded_by: Mapped[str | None] = mapped_column(default=None)
    origin: Mapped[str] = mapped_column(default="catalogue", server_default="catalogue")

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
    connection_id: Mapped[int | None] = mapped_column(ForeignKey("connections.id", ondelete="SET NULL"), default=None)
    files: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    size_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    status: Mapped[str]
    error: Mapped[str | None] = mapped_column(default=None)
    template_kwargs: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    stop_tokens: Mapped[list[str]] = mapped_column(JSON, default=list)
    license: Mapped[str | None] = mapped_column(default=None)
    license_ack_by: Mapped[str | None] = mapped_column(default=None)
    license_ack_at: Mapped[datetime | None] = mapped_column(UtcDateTime, default=None)
    deployed: Mapped[bool] = mapped_column(default=False)
    verified: Mapped[bool] = mapped_column(default=False, server_default=false())
    path: Mapped[str | None] = mapped_column(default=None)
    health: Mapped[str | None] = mapped_column(default=None)
    health_detail: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, server_default="{}")
    verified_at: Mapped[datetime | None] = mapped_column(UtcDateTime, default=None)
    last_used_at: Mapped[datetime | None] = mapped_column(UtcDateTime, default=now)
    pinned: Mapped[bool] = mapped_column(default=False, server_default=false())
    evicted_at: Mapped[datetime | None] = mapped_column(UtcDateTime, default=None)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now)

    variant: Mapped[CatalogVariant | None] = relationship()


class Setting(Base):
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(primary_key=True)
    value: Mapped[Any] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now)


class AuditEvent(Base):
    __tablename__ = "audit_events"
    __table_args__ = (
        Index("ix_audit_events_at", "at"),
        Index("ix_audit_events_action", "action"),
        Index("ix_audit_events_actor", "actor"),
        Index("ix_audit_events_seq", "seq", unique=True),
        {"sqlite_autoincrement": True},
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    at: Mapped[datetime] = mapped_column(UtcDateTime, default=now)
    actor: Mapped[str]
    action: Mapped[str]
    target: Mapped[str]
    detail: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    ip: Mapped[str | None] = mapped_column(default=peer_address)
    seq: Mapped[int | None] = mapped_column(BigInteger, default=None)
    prev_hash: Mapped[str | None] = mapped_column(default=None)
    hash: Mapped[str | None] = mapped_column(default=None)


class AuditChain(Base):
    __tablename__ = "audit_chain"

    id: Mapped[int] = mapped_column(primary_key=True)
    seq: Mapped[int] = mapped_column(BigInteger)
    hash: Mapped[str]
    forwarded_seq: Mapped[int] = mapped_column(BigInteger, default=0)
    forwarded_at: Mapped[datetime | None] = mapped_column(UtcDateTime, default=None)
    forward_error: Mapped[str | None] = mapped_column(default=None)


class Node(Base):
    __tablename__ = "nodes"

    id: Mapped[str] = mapped_column(primary_key=True)
    pool: Mapped[str] = mapped_column(index=True)
    host: Mapped[str]
    roles: Mapped[list[str]] = mapped_column(JSON, default=list)
    hardware: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    started_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now)
    seen_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now)


class EngineReplica(Base):
    __tablename__ = "engine_replicas"

    id: Mapped[str] = mapped_column(primary_key=True)
    node_id: Mapped[str]
    pool: Mapped[str]
    base_model: Mapped[str] = mapped_column(index=True)
    engine: Mapped[str]
    url: Mapped[str]
    state: Mapped[str]
    started_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now)
    seen_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now)
