import sqlalchemy as sa
from alembic import op

revision = "0039"
down_revision = "0038"


def upgrade() -> None:
    with op.batch_alter_table("models") as batch:
        batch.add_column(sa.Column("store", sa.String(), nullable=False, server_default="folder"))


def downgrade() -> None:
    with op.batch_alter_table("models") as batch:
        batch.drop_column("store")
