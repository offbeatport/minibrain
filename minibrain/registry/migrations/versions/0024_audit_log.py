import sqlalchemy as sa
from alembic import op

revision = "0024"
down_revision = "0023"

AUTOINCREMENT = {"sqlite_autoincrement": True}
INDEXES = {"ix_audit_events_at": "at", "ix_audit_events_action": "action", "ix_audit_events_actor": "actor"}


def upgrade() -> None:
    with op.batch_alter_table("audit_events", table_kwargs=AUTOINCREMENT) as batch:
        batch.add_column(sa.Column("ip", sa.String(), nullable=True))
    for name, column in INDEXES.items():
        op.create_index(name, "audit_events", [column])


def downgrade() -> None:
    for name in INDEXES:
        op.drop_index(name, table_name="audit_events")
    with op.batch_alter_table("audit_events", table_kwargs=AUTOINCREMENT) as batch:
        batch.drop_column("ip")
