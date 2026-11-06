import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"


def upgrade() -> None:
    with op.batch_alter_table("models") as batch:
        batch.add_column(sa.Column("first_live_at", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column("labels_dismissed", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("models") as batch:
        batch.drop_column("labels_dismissed")
        batch.drop_column("first_live_at")
