import sqlalchemy as sa
from alembic import op

revision = "0014"
down_revision = "0013"

TABLES = ("minibrains", "models")


def upgrade() -> None:
    for table in TABLES:
        with op.batch_alter_table(table) as batch:
            batch.drop_column("archived_at")


def downgrade() -> None:
    for table in TABLES:
        with op.batch_alter_table(table) as batch:
            batch.add_column(sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True))
