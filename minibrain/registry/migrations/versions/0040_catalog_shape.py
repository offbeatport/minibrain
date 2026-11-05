import sqlalchemy as sa
from alembic import op

revision = "0040"
down_revision = "0039"


def upgrade() -> None:
    with op.batch_alter_table("catalog_models") as batch:
        batch.add_column(sa.Column("shape", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("catalog_models") as batch:
        batch.drop_column("shape")
