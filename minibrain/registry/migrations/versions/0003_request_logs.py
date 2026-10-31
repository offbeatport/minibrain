import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"


def upgrade() -> None:
    op.create_table(
        "request_logs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("key_id", sa.Integer(), nullable=True),
        sa.Column("minibrain_id", sa.Integer(), nullable=True),
        sa.Column("model", sa.String(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=True),
        sa.Column("status", sa.Integer(), nullable=False),
        sa.Column("latency_ms", sa.Double(), nullable=False),
        sa.Column("prompt_tokens", sa.Integer(), nullable=False),
        sa.Column("completion_tokens", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["key_id"], ["api_keys.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["minibrain_id"], ["minibrains.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sqlite_autoincrement=True,
    )
    op.create_index("ix_request_logs_minibrain", "request_logs", ["minibrain_id", "id"])


def downgrade() -> None:
    op.drop_index("ix_request_logs_minibrain", "request_logs")
    op.drop_table("request_logs")
