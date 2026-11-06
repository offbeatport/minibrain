import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"


def upgrade() -> None:
    with op.batch_alter_table("models") as batch:
        batch.add_column(sa.Column("safety", sa.JSON(), nullable=True))
    with op.batch_alter_table("request_logs") as batch:
        batch.add_column(sa.Column("safety", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("request_logs") as batch:
        batch.drop_column("safety")
    with op.batch_alter_table("models") as batch:
        batch.drop_column("safety")
