import sqlalchemy as sa
from alembic import op

revision = "0013"
down_revision = "0012"


def upgrade() -> None:
    with op.batch_alter_table("request_logs") as batch:
        batch.add_column(sa.Column("kind", sa.String(), nullable=False, server_default="chat"))


def downgrade() -> None:
    with op.batch_alter_table("request_logs") as batch:
        batch.drop_column("kind")
