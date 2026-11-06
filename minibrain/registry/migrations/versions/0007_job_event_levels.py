import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"


def upgrade() -> None:
    with op.batch_alter_table("job_events") as batch:
        batch.add_column(sa.Column("level", sa.String(), server_default="info", nullable=False))
        batch.add_column(sa.Column("name", sa.String(), nullable=True))
    op.create_index("ix_job_events_name", "job_events", ["job_id", "name", "id"])


def downgrade() -> None:
    op.drop_index("ix_job_events_name", table_name="job_events")
    with op.batch_alter_table("job_events") as batch:
        batch.drop_column("name")
        batch.drop_column("level")
