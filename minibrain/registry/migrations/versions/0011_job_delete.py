import sqlalchemy as sa
from alembic import op

revision = "0011"
down_revision = "0010"

KEEP = {"recreate": "always", "table_kwargs": {"sqlite_autoincrement": True}}


def upgrade() -> None:
    with op.batch_alter_table("jobs", **KEEP) as batch:
        batch.add_column(sa.Column("delete_requested", sa.Boolean(), server_default=sa.false(), nullable=False))


def downgrade() -> None:
    with op.batch_alter_table("jobs", **KEEP) as batch:
        batch.drop_column("delete_requested")
