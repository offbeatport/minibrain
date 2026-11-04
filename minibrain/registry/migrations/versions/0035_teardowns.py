import sqlalchemy as sa
from alembic import op

revision = "0035"
down_revision = "0034"


def upgrade() -> None:
    op.create_table(
        "teardowns",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("minibrain_id", sa.Integer(), sa.ForeignKey("minibrains.id", ondelete="CASCADE"), nullable=True),
        sa.Column("model_id", sa.String(), sa.ForeignKey("models.id", ondelete="CASCADE"), nullable=True),
        sa.Column("parent_id", sa.Integer(), sa.ForeignKey("teardowns.id", ondelete="SET NULL"), nullable=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("step", sa.String(), nullable=False),
        sa.Column("actor", sa.String(), nullable=False),
        sa.Column("detail", sa.JSON(), nullable=False),
        sa.Column("error", sa.String(), nullable=True),
        sa.Column("attempt", sa.Integer(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("minibrain_id"),
        sa.UniqueConstraint("model_id"),
        sqlite_autoincrement=True,
    )
    op.create_table(
        "gateways",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("host", sa.String(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("version", sa.String(), nullable=False),
        sa.Column("routes", sa.JSON(), nullable=False),
        sa.Column("bases", sa.JSON(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("seen_at", sa.DateTime(timezone=True), nullable=False),
    )
    with op.batch_alter_table("engine_replicas") as batch:
        batch.add_column(sa.Column("managed", sa.Boolean(), nullable=False, server_default=sa.false()))
    with op.batch_alter_table("models") as batch:
        batch.add_column(sa.Column("evicted_by", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("models") as batch:
        batch.drop_column("evicted_by")
    with op.batch_alter_table("engine_replicas") as batch:
        batch.drop_column("managed")
    op.drop_table("gateways")
    op.drop_table("teardowns")
