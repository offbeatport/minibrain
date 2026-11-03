import sqlalchemy as sa
from alembic import op

revision = "0029"
down_revision = "0028"

AUTOINCREMENT = {"sqlite_autoincrement": True}
LOG_COLUMNS = ("response_id", "input", "output")


def upgrade() -> None:
    with op.batch_alter_table("request_logs", table_kwargs=AUTOINCREMENT) as batch:
        for name in LOG_COLUMNS:
            batch.add_column(sa.Column(name, sa.String(), nullable=True))
    op.create_index("ix_request_logs_response", "request_logs", ["response_id"])
    with op.batch_alter_table("snapshots", table_kwargs=AUTOINCREMENT) as batch:
        batch.add_column(sa.Column("feedback_rows", sa.Integer(), nullable=False, server_default="0"))
    op.create_table(
        "feedback",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "minibrain_id", sa.Integer(), sa.ForeignKey("minibrains.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("version", sa.Integer(), nullable=True),
        sa.Column("response_id", sa.String(), nullable=True),
        sa.Column("origin", sa.String(), nullable=False),
        sa.Column("key_id", sa.Integer(), sa.ForeignKey("api_keys.id", ondelete="SET NULL"), nullable=True),
        sa.Column("rating", sa.String(), nullable=False),
        sa.Column("input", sa.String(), nullable=False),
        sa.Column("input_key", sa.String(), nullable=False),
        sa.Column("output", sa.String(), nullable=True),
        sa.Column("correction", sa.String(), nullable=True),
        sa.Column("comment", sa.String(), nullable=True),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("label", sa.String(), nullable=True),
        sa.Column("priority", sa.Integer(), nullable=False),
        sa.Column("assignee", sa.String(), nullable=True),
        sa.Column("reviewed_by", sa.String(), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sqlite_autoincrement=True,
    )
    op.create_index("ix_feedback_queue", "feedback", ["priority", "id"])
    op.create_index("ix_feedback_input", "feedback", ["minibrain_id", "input_key"])
    op.create_index("ix_feedback_response", "feedback", ["response_id"])


def downgrade() -> None:
    for name in ("ix_feedback_response", "ix_feedback_input", "ix_feedback_queue"):
        op.drop_index(name, table_name="feedback")
    op.drop_table("feedback")
    with op.batch_alter_table("snapshots", table_kwargs=AUTOINCREMENT) as batch:
        batch.drop_column("feedback_rows")
    op.drop_index("ix_request_logs_response", table_name="request_logs")
    with op.batch_alter_table("request_logs", table_kwargs=AUTOINCREMENT) as batch:
        for name in reversed(LOG_COLUMNS):
            batch.drop_column(name)
