import sqlalchemy as sa
from alembic import op

revision = "0010"
down_revision = "0009"


def upgrade() -> None:
    with op.batch_alter_table("minibrains", table_kwargs={"sqlite_autoincrement": True}) as batch:
        batch.add_column(sa.Column("deployed", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.execute("UPDATE minibrains SET deployed = (current_version IS NOT NULL)")


def downgrade() -> None:
    with op.batch_alter_table("minibrains", table_kwargs={"sqlite_autoincrement": True}) as batch:
        batch.drop_column("deployed")
