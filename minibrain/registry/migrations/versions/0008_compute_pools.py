import sqlalchemy as sa
from alembic import op

revision = "0008"
down_revision = "0007"


def upgrade() -> None:
    op.create_table(
        "nodes",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("pool", sa.String(), nullable=False),
        sa.Column("host", sa.String(), nullable=False),
        sa.Column("roles", sa.JSON(), nullable=False),
        sa.Column("hardware", sa.JSON(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_nodes_pool", "nodes", ["pool"])
    op.create_table(
        "engine_replicas",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("node_id", sa.String(), nullable=False),
        sa.Column("pool", sa.String(), nullable=False),
        sa.Column("base_model", sa.String(), nullable=False),
        sa.Column("engine", sa.String(), nullable=False),
        sa.Column("url", sa.String(), nullable=False),
        sa.Column("state", sa.String(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_engine_replicas_base_model", "engine_replicas", ["base_model"])


def downgrade() -> None:
    op.drop_index("ix_engine_replicas_base_model", "engine_replicas")
    op.drop_table("engine_replicas")
    op.drop_index("ix_nodes_pool", "nodes")
    op.drop_table("nodes")
