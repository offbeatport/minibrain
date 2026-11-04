import sqlalchemy as sa
from alembic import op

revision = "0036"
down_revision = "0035"

COLUMNS = (
    sa.Column("context_tokens", sa.Integer(), nullable=True),
    sa.Column("released", sa.String(), nullable=True),
)


def upgrade() -> None:
    with op.batch_alter_table("catalog_models") as batch:
        for column in COLUMNS:
            batch.add_column(column)


def downgrade() -> None:
    with op.batch_alter_table("catalog_models") as batch:
        for column in COLUMNS:
            batch.drop_column(column.name)
