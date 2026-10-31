import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"

TIMESTAMP = sa.DateTime(timezone=True)
ACTIVE = "status IN ('queued', 'running')"

COPY_LEGACY_JOBS = """
INSERT INTO jobs (
    id, kind, minibrain_id, version_id, params, needs_gpu, status, priority, attempt, max_attempts,
    run_after, cancel_requested, progress, outputs, error, created_at, started_at, finished_at
)
SELECT
    id, kind, minibrain_id, version_id, '{}',
    CASE WHEN kind = 'train' THEN TRUE ELSE FALSE END,
    CASE status
        WHEN 'done' THEN 'succeeded'
        WHEN 'failed' THEN 'failed'
        WHEN 'cancelled' THEN 'cancelled'
        ELSE 'failed'
    END,
    0,
    CASE WHEN status IN ('done', 'failed', 'cancelled') THEN 1 ELSE 0 END,
    3, created_at, FALSE, progress, '{}',
    CASE WHEN status IN ('queued', 'running', 'cancelling') THEN 'stopped by the upgrade to the job contract'
         ELSE error END,
    created_at, started_at, COALESCE(finished_at, created_at)
FROM jobs_legacy
"""


def upgrade() -> None:
    op.create_table(
        "artifacts",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("packing", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("minibrains") as batch:
        batch.add_column(sa.Column("source_artifact_id", sa.String(), nullable=True))
        batch.create_foreign_key("fk_minibrains_source_artifact", "artifacts", ["source_artifact_id"], ["id"])
    with op.batch_alter_table("snapshots") as batch:
        batch.add_column(sa.Column("artifact_id", sa.String(), nullable=True))
        batch.alter_column("directory", existing_type=sa.String(), nullable=True)
        batch.create_foreign_key("fk_snapshots_artifact", "artifacts", ["artifact_id"], ["id"])
    with op.batch_alter_table("versions") as batch:
        batch.add_column(sa.Column("adapter_artifact_id", sa.String(), nullable=True))
        batch.create_foreign_key("fk_versions_adapter_artifact", "artifacts", ["adapter_artifact_id"], ["id"])
    op.create_table(
        "workers",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("host", sa.String(), nullable=False),
        sa.Column("kinds", sa.JSON(), nullable=False),
        sa.Column("gpus", sa.Integer(), nullable=False),
        sa.Column("started_at", TIMESTAMP, nullable=False),
        sa.Column("seen_at", TIMESTAMP, nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.rename_table("jobs", "jobs_legacy")
    op.create_table(
        "jobs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("minibrain_id", sa.Integer(), nullable=True),
        sa.Column("version_id", sa.Integer(), nullable=True),
        sa.Column("params", sa.JSON(), nullable=False),
        sa.Column("needs_gpu", sa.Boolean(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("priority", sa.Integer(), nullable=False),
        sa.Column("attempt", sa.Integer(), nullable=False),
        sa.Column("max_attempts", sa.Integer(), nullable=False),
        sa.Column("run_after", TIMESTAMP, nullable=False),
        sa.Column("lease_owner", sa.String(), nullable=True),
        sa.Column("lease_token", sa.String(), nullable=True),
        sa.Column("lease_expires_at", TIMESTAMP, nullable=True),
        sa.Column("cancel_requested", sa.Boolean(), nullable=False),
        sa.Column("idempotency_key", sa.String(), nullable=True),
        sa.Column("retry_of", sa.Integer(), nullable=True),
        sa.Column("progress", sa.Double(), nullable=False),
        sa.Column("result", sa.JSON(), nullable=True),
        sa.Column("outputs", sa.JSON(), nullable=False),
        sa.Column("error", sa.String(), nullable=True),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("started_at", TIMESTAMP, nullable=True),
        sa.Column("finished_at", TIMESTAMP, nullable=True),
        sa.ForeignKeyConstraint(["minibrain_id"], ["minibrains.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["version_id"], ["versions.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["retry_of"], ["jobs.id"]),
        sa.PrimaryKeyConstraint("id"),
        sqlite_autoincrement=True,
    )
    op.execute(COPY_LEGACY_JOBS)
    op.drop_table("jobs_legacy")
    op.create_index("ix_jobs_claim", "jobs", ["status", "priority", "id"])
    op.create_index(
        "uq_jobs_active_key",
        "jobs",
        ["idempotency_key"],
        unique=True,
        sqlite_where=sa.text(ACTIVE),
        postgresql_where=sa.text(ACTIVE),
    )
    op.create_table(
        "job_attempts",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("job_id", sa.Integer(), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("worker", sa.String(), nullable=False),
        sa.Column("outcome", sa.String(), nullable=False),
        sa.Column("error", sa.String(), nullable=True),
        sa.Column("retryable", sa.Boolean(), nullable=True),
        sa.Column("log_artifact_id", sa.String(), nullable=True),
        sa.Column("started_at", TIMESTAMP, nullable=False),
        sa.Column("finished_at", TIMESTAMP, nullable=True),
        sa.ForeignKeyConstraint(["job_id"], ["jobs.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["log_artifact_id"], ["artifacts.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("job_id", "number"),
    )
    op.create_table(
        "job_events",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("job_id", sa.Integer(), nullable=False),
        sa.Column("attempt", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("message", sa.String(), nullable=False),
        sa.Column("data", sa.JSON(), nullable=True),
        sa.Column("at", TIMESTAMP, nullable=False),
        sa.ForeignKeyConstraint(["job_id"], ["jobs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sqlite_autoincrement=True,
    )
    op.create_index("ix_job_events_job", "job_events", ["job_id", "id"])


def downgrade() -> None:
    raise RuntimeError("0002 changes the jobs table in place and has no downgrade")
