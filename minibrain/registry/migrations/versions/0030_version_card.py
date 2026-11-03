import sqlalchemy as sa
from alembic import op

revision = "0030"
down_revision = "0029"

AUTOINCREMENT = {"sqlite_autoincrement": True}


def upgrade() -> None:
    with op.batch_alter_table("versions", table_kwargs=AUTOINCREMENT) as batch:
        batch.add_column(sa.Column("intended_use", sa.String(), nullable=True))
        batch.add_column(sa.Column("known_limits", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("versions", table_kwargs=AUTOINCREMENT) as batch:
        batch.drop_column("known_limits")
        batch.drop_column("intended_use")
