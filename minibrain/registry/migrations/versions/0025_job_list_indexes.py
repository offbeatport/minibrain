from alembic import op

revision = "0025"
down_revision = "0024"

INDEXES = {"ix_jobs_kind": ["kind", "id"], "ix_jobs_minibrain": ["minibrain_id", "id"]}


def upgrade() -> None:
    for name, columns in INDEXES.items():
        op.create_index(name, "jobs", columns)


def downgrade() -> None:
    for name in INDEXES:
        op.drop_index(name, table_name="jobs")
