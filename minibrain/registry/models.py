from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from sqlalchemy import JSON, ForeignKey, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from minibrain.registry.db import Base


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
    TRAIN = "train"
    EVAL = "eval"


class JobStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    CANCELLING = "cancelling"
    DONE = "done"
    FAILED = "failed"
    CANCELLED = "cancelled"


ACTIVE_JOB_STATUSES = (JobStatus.QUEUED, JobStatus.RUNNING, JobStatus.CANCELLING)


class Minibrain(Base):
    __tablename__ = "minibrains"

    id: Mapped[int] = mapped_column(primary_key=True)
    slug: Mapped[str] = mapped_column(unique=True)
    name: Mapped[str]
    task: Mapped[str]
    base_model: Mapped[str]
    source_file: Mapped[str | None] = mapped_column(default=None)
    input_column: Mapped[str | None] = mapped_column(default=None)
    label_column: Mapped[str | None] = mapped_column(default=None)
    sql: Mapped[str | None] = mapped_column(default=None)
    current_version: Mapped[int | None] = mapped_column(default=None)
    created_at: Mapped[datetime] = mapped_column(default=now)

    snapshots: Mapped[list["Snapshot"]] = relationship(back_populates="minibrain", cascade="all, delete-orphan")
    versions: Mapped[list["Version"]] = relationship(back_populates="minibrain", cascade="all, delete-orphan")
    jobs: Mapped[list["Job"]] = relationship(back_populates="minibrain", cascade="all, delete-orphan")
    keys: Mapped[list["ApiKey"]] = relationship(back_populates="minibrain", cascade="all, delete-orphan")


class Snapshot(Base):
    __tablename__ = "snapshots"

    id: Mapped[int] = mapped_column(primary_key=True)
    minibrain_id: Mapped[int] = mapped_column(ForeignKey("minibrains.id", ondelete="CASCADE"))
    hash: Mapped[str]
    directory: Mapped[str]
    counts: Mapped[dict[str, int]] = mapped_column(JSON)
    labels: Mapped[list[str]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(default=now)

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
    recipe: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    metrics: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=None)
    created_at: Mapped[datetime] = mapped_column(default=now)

    minibrain: Mapped[Minibrain] = relationship(back_populates="versions")
    snapshot: Mapped[Snapshot] = relationship()


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[int] = mapped_column(primary_key=True)
    minibrain_id: Mapped[int] = mapped_column(ForeignKey("minibrains.id", ondelete="CASCADE"))
    version_id: Mapped[int] = mapped_column(ForeignKey("versions.id", ondelete="CASCADE"))
    kind: Mapped[str]
    status: Mapped[str] = mapped_column(default=JobStatus.QUEUED)
    progress: Mapped[float] = mapped_column(default=0.0)
    log_path: Mapped[str]
    error: Mapped[str | None] = mapped_column(default=None)
    created_at: Mapped[datetime] = mapped_column(default=now)
    started_at: Mapped[datetime | None] = mapped_column(default=None)
    finished_at: Mapped[datetime | None] = mapped_column(default=None)

    minibrain: Mapped[Minibrain] = relationship(back_populates="jobs")
    version: Mapped[Version] = relationship()


class ApiKey(Base):
    __tablename__ = "api_keys"

    id: Mapped[int] = mapped_column(primary_key=True)
    minibrain_id: Mapped[int] = mapped_column(ForeignKey("minibrains.id", ondelete="CASCADE"))
    name: Mapped[str]
    prefix: Mapped[str]
    digest: Mapped[str] = mapped_column(unique=True)
    created_at: Mapped[datetime] = mapped_column(default=now)
    last_used_at: Mapped[datetime | None] = mapped_column(default=None)

    minibrain: Mapped[Minibrain] = relationship(back_populates="keys")
