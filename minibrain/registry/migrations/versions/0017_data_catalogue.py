import sqlalchemy as sa
from alembic import op

revision = "0017"
down_revision = "0016"

TABLES = ("sources", "datasets")


def upgrade() -> None:
    for table in TABLES:
        with op.batch_alter_table(table) as batch:
            batch.add_column(sa.Column("description", sa.String(), nullable=True))
            batch.add_column(sa.Column("tags", sa.JSON(), nullable=True))


def downgrade() -> None:
    for table in TABLES:
        with op.batch_alter_table(table) as batch:
            batch.drop_column("tags")
            batch.drop_column("description")
