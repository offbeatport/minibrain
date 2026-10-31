import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"

COLUMNS = (
    sa.Column("family", sa.String(), nullable=False, server_default=""),
    sa.Column("generation", sa.String(), nullable=False, server_default=""),
    sa.Column("architecture", sa.String(), nullable=False, server_default=""),
    sa.Column("tier", sa.String(), nullable=False, server_default="S"),
    sa.Column("params_b", sa.Double(), nullable=False, server_default="0"),
    sa.Column("moe", sa.Boolean(), nullable=False, server_default=sa.false()),
    sa.Column("support", sa.String(), nullable=False, server_default="supported"),
    sa.Column("superseded_by", sa.String(), nullable=True),
    sa.Column("origin", sa.String(), nullable=False, server_default="catalogue"),
)


def upgrade() -> None:
    with op.batch_alter_table("catalog_models") as batch:
        for column in COLUMNS:
            batch.add_column(column)


def downgrade() -> None:
    with op.batch_alter_table("catalog_models") as batch:
        for column in COLUMNS:
            batch.drop_column(column.name)
