import sqlalchemy as sa
from alembic import op

revision = "0015"
down_revision = "0014"


def upgrade() -> None:
    with op.batch_alter_table("catalog_models") as batch:
        batch.drop_column("support")


def downgrade() -> None:
    with op.batch_alter_table("catalog_models") as batch:
        batch.add_column(sa.Column("support", sa.String(), nullable=False, server_default="supported"))
