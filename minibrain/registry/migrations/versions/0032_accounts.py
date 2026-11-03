import sqlalchemy as sa
from alembic import op

revision = "0032"
down_revision = "0031"

AUTOINCREMENT = {"sqlite_autoincrement": True}


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("email", sa.String(), nullable=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("source", sa.String(), nullable=False),
        sa.Column("subject", sa.String(), nullable=False),
        sa.Column("role", sa.String(), nullable=True),
        sa.Column("groups", sa.JSON(), nullable=False),
        sa.Column("disabled", sa.Boolean(), nullable=False),
        sa.Column("password_hash", sa.String(), nullable=True),
        sa.Column("reset_hash", sa.String(), nullable=True),
        sa.Column("reset_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failed_sign_ins", sa.Integer(), nullable=False),
        sa.Column("locked_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_sign_in_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("source", "subject", name="uq_users_source_subject"),
        sqlite_autoincrement=True,
    )
    op.create_index("ix_users_email", "users", ["email"])
    op.create_index("ix_users_reset_hash", "users", ["reset_hash"], unique=True)
    op.create_table(
        "sessions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("token_hash", sa.String(), nullable=False, unique=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ip", sa.String(), nullable=True),
        sa.Column("user_agent", sa.String(), nullable=True),
        sqlite_autoincrement=True,
    )
    op.create_index("ix_sessions_user", "sessions", ["user_id"])
    with op.batch_alter_table("api_keys", table_kwargs=AUTOINCREMENT) as batch:
        batch.add_column(sa.Column("created_by", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("api_keys", table_kwargs=AUTOINCREMENT) as batch:
        batch.drop_column("created_by")
    op.drop_index("ix_sessions_user", table_name="sessions")
    op.drop_table("sessions")
    op.drop_index("ix_users_reset_hash", table_name="users")
    op.drop_index("ix_users_email", table_name="users")
    op.drop_table("users")
