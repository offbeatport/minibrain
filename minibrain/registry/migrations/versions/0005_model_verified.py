import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"


def upgrade() -> None:
    with op.batch_alter_table("models") as batch:
        batch.add_column(sa.Column("verified", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.execute("UPDATE models SET verified = TRUE WHERE source = 'download' AND status = 'available'")


def downgrade() -> None:
    with op.batch_alter_table("models") as batch:
        batch.drop_column("verified")
