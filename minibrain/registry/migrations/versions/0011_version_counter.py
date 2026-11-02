import sqlalchemy as sa
from alembic import op

revision = "0011"
down_revision = "0010"


def upgrade() -> None:
    with op.batch_alter_table("minibrains") as batch:
        batch.add_column(sa.Column("last_version", sa.Integer(), nullable=False, server_default="-1"))
    op.execute(
        "UPDATE minibrains SET last_version = "
        "COALESCE((SELECT MAX(number) FROM versions WHERE versions.minibrain_id = minibrains.id), -1)"
    )


def downgrade() -> None:
    with op.batch_alter_table("minibrains") as batch:
        batch.drop_column("last_version")
