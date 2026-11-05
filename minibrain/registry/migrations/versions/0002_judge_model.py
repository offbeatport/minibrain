import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"


def upgrade() -> None:
    with op.batch_alter_table("models") as batch:
        batch.add_column(sa.Column("judge_model", sa.String(), nullable=True))
    with op.batch_alter_table("judge_scores") as batch:
        batch.add_column(sa.Column("reason", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("judge_scores") as batch:
        batch.drop_column("reason")
    with op.batch_alter_table("models") as batch:
        batch.drop_column("judge_model")
