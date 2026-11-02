import sqlalchemy as sa
from alembic import op

revision = "0016"
down_revision = "0015"

TABLES = ("catalog_models", "models")


def upgrade() -> None:
    for table in TABLES:
        with op.batch_alter_table(table) as batch:
            batch.drop_column("trainable")


def downgrade() -> None:
    for table in TABLES:
        with op.batch_alter_table(table) as batch:
            batch.add_column(sa.Column("trainable", sa.Boolean(), nullable=False, server_default=sa.false()))
