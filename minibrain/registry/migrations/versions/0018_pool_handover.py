import sqlalchemy as sa
from alembic import op

revision = "0018"
down_revision = "0017"

DEPLOYED = ("models", "base_models")


def upgrade() -> None:
    for table in DEPLOYED:
        with op.batch_alter_table(table) as batch:
            batch.add_column(sa.Column("moving_from", sa.String(), nullable=True))
            batch.add_column(sa.Column("moving_since", sa.DateTime(timezone=True), nullable=True))
            batch.add_column(sa.Column("move_failure", sa.String(), nullable=True))


def downgrade() -> None:
    for table in DEPLOYED:
        with op.batch_alter_table(table) as batch:
            batch.drop_column("move_failure")
            batch.drop_column("moving_since")
            batch.drop_column("moving_from")
