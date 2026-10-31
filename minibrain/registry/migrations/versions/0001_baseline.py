import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None

TIMESTAMP = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "minibrains",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("slug", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("task", sa.String(), nullable=False),
        sa.Column("base_model", sa.String(), nullable=False),
        sa.Column("source_file", sa.String(), nullable=True),
        sa.Column("input_column", sa.String(), nullable=True),
        sa.Column("label_column", sa.String(), nullable=True),
        sa.Column("sql", sa.String(), nullable=True),
        sa.Column("current_version", sa.Integer(), nullable=True),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("slug"),
    )
    op.create_table(
        "api_keys",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("minibrain_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("prefix", sa.String(), nullable=False),
        sa.Column("digest", sa.String(), nullable=False),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("last_used_at", TIMESTAMP, nullable=True),
        sa.ForeignKeyConstraint(["minibrain_id"], ["minibrains.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("digest"),
    )
    op.create_table(
        "snapshots",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("minibrain_id", sa.Integer(), nullable=False),
        sa.Column("hash", sa.String(), nullable=False),
        sa.Column("directory", sa.String(), nullable=False),
        sa.Column("counts", sa.JSON(), nullable=False),
        sa.Column("labels", sa.JSON(), nullable=False),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.ForeignKeyConstraint(["minibrain_id"], ["minibrains.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "versions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("minibrain_id", sa.Integer(), nullable=False),
        sa.Column("snapshot_id", sa.Integer(), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("adapter_dir", sa.String(), nullable=True),
        sa.Column("recipe", sa.JSON(), nullable=False),
        sa.Column("metrics", sa.JSON(), nullable=True),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.ForeignKeyConstraint(["minibrain_id"], ["minibrains.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["snapshot_id"], ["snapshots.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("minibrain_id", "number"),
    )
    op.create_table(
        "jobs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("minibrain_id", sa.Integer(), nullable=False),
        sa.Column("version_id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("progress", sa.Double(), nullable=False),
        sa.Column("log_path", sa.String(), nullable=False),
        sa.Column("error", sa.String(), nullable=True),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("started_at", TIMESTAMP, nullable=True),
        sa.Column("finished_at", TIMESTAMP, nullable=True),
        sa.ForeignKeyConstraint(["minibrain_id"], ["minibrains.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["version_id"], ["versions.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sqlite_autoincrement=True,
    )


def downgrade() -> None:
    for table in ("jobs", "versions", "snapshots", "api_keys", "minibrains"):
        op.drop_table(table)
