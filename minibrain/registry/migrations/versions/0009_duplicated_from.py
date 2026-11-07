import sqlalchemy as sa
from alembic import op

revision = "0009"
down_revision = "0008"


def upgrade() -> None:
    with op.batch_alter_table("versions") as batch:
        batch.add_column(sa.Column("duplicated_from", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("versions") as batch:
        batch.drop_column("duplicated_from")
