import sqlalchemy as sa
from alembic import op

revision = "0033"
down_revision = "0032"

AUTOINCREMENT = {"sqlite_autoincrement": True}
INDEXES = {"ix_request_logs_at": ["at"], "ix_request_logs_key": ["key_id", "id"]}


def upgrade() -> None:
    with op.batch_alter_table("request_logs", table_kwargs=AUTOINCREMENT) as batch:
        batch.add_column(sa.Column("finish_reason", sa.String(), nullable=True))
    for name, columns in INDEXES.items():
        op.create_index(name, "request_logs", columns)


def downgrade() -> None:
    for name in INDEXES:
        op.drop_index(name, table_name="request_logs")
    with op.batch_alter_table("request_logs", table_kwargs=AUTOINCREMENT) as batch:
        batch.drop_column("finish_reason")
