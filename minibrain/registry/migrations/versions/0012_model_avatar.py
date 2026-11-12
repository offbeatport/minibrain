import sqlalchemy as sa
from alembic import op

revision = "0012"
down_revision = "0011"


def upgrade() -> None:
    with op.batch_alter_table("models") as batch:
        batch.add_column(sa.Column("avatar", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("models") as batch:
        batch.drop_column("avatar")
