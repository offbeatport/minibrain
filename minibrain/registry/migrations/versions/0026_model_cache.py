import sqlalchemy as sa
from alembic import op

revision = "0026"
down_revision = "0025"


def upgrade() -> None:
    with op.batch_alter_table("models") as batch:
        batch.add_column(sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column("pinned", sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.add_column(sa.Column("evicted_at", sa.DateTime(timezone=True), nullable=True))
    op.execute("UPDATE models SET last_used_at = created_at")


def downgrade() -> None:
    with op.batch_alter_table("models") as batch:
        batch.drop_column("evicted_at")
        batch.drop_column("pinned")
        batch.drop_column("last_used_at")
