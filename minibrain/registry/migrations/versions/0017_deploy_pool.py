import sqlalchemy as sa
from alembic import op

revision = "0017"
down_revision = "0016"

DEPLOYED = ("models", "base_models")


def upgrade() -> None:
    for table in DEPLOYED:
        with op.batch_alter_table(table) as batch:
            batch.add_column(sa.Column("pool", sa.String(), nullable=True))
            batch.add_column(sa.Column("replicas", sa.Integer(), server_default="1", nullable=False))
    with op.batch_alter_table("workers") as batch:
        batch.add_column(sa.Column("pool", sa.String(), server_default="local", nullable=False))


def downgrade() -> None:
    with op.batch_alter_table("workers") as batch:
        batch.drop_column("pool")
    for table in DEPLOYED:
        with op.batch_alter_table(table) as batch:
            batch.drop_column("replicas")
            batch.drop_column("pool")
