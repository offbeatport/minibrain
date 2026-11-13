import sqlalchemy as sa
from alembic import op

revision = "0016"
down_revision = "0015"

KEEP = {"recreate": "always", "table_kwargs": {"sqlite_autoincrement": True}}


def upgrade() -> None:
    with op.batch_alter_table("jobs", **KEEP) as batch:
        batch.add_column(sa.Column("pool", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("jobs", **KEEP) as batch:
        batch.drop_column("pool")
