import sqlalchemy as sa
from alembic import op

revision = "0023"
down_revision = "0022"

AUTOINCREMENT = {"sqlite_autoincrement": True}


def upgrade() -> None:
    with op.batch_alter_table("snapshots", table_kwargs=AUTOINCREMENT) as batch:
        batch.add_column(sa.Column("checks", sa.JSON(), nullable=True))
    with op.batch_alter_table("datasets", table_kwargs=AUTOINCREMENT) as batch:
        batch.add_column(sa.Column("dismissed", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("datasets", table_kwargs=AUTOINCREMENT) as batch:
        batch.drop_column("dismissed")
    with op.batch_alter_table("snapshots", table_kwargs=AUTOINCREMENT) as batch:
        batch.drop_column("checks")
