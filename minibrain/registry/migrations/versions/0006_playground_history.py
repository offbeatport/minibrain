import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"

TIMESTAMP = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "playground_sessions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("model", sa.String(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=True),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("content", sa.String(), nullable=False),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("updated_at", TIMESTAMP, nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sqlite_autoincrement=True,
    )
    op.create_index("ix_playground_sessions_user", "playground_sessions", ["user_id", "updated_at"])
    with op.batch_alter_table("feedback") as batch:
        batch.add_column(sa.Column("messages", sa.JSON(), nullable=True))
        batch.add_column(sa.Column("split", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("feedback") as batch:
        batch.drop_column("split")
        batch.drop_column("messages")
    op.drop_index("ix_playground_sessions_user", table_name="playground_sessions")
    op.drop_table("playground_sessions")
