import sqlalchemy as sa
from alembic import op

revision = "0015"
down_revision = "0014"

KEEP = {"recreate": "always", "table_kwargs": {"sqlite_autoincrement": True}}


def upgrade() -> None:
    with op.batch_alter_table("api_keys", **KEEP) as batch:
        batch.add_column(sa.Column("all_models", sa.Boolean(), server_default=sa.false(), nullable=False))


def downgrade() -> None:
    with op.batch_alter_table("api_keys", **KEEP) as batch:
        batch.drop_column("all_models")
