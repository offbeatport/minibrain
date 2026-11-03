import sqlalchemy as sa
from alembic import op

revision = "0031"
down_revision = "0030"

AUTOINCREMENT = {"sqlite_autoincrement": True}
GENESIS = "0" * 64
CHAIN_COLUMNS = ("seq", "prev_hash", "hash")


def upgrade() -> None:
    with op.batch_alter_table("audit_events", table_kwargs=AUTOINCREMENT) as batch:
        batch.add_column(sa.Column("seq", sa.BigInteger(), nullable=True))
        batch.add_column(sa.Column("prev_hash", sa.String(), nullable=True))
        batch.add_column(sa.Column("hash", sa.String(), nullable=True))
    op.create_index("ix_audit_events_seq", "audit_events", ["seq"], unique=True)
    chain = op.create_table(
        "audit_chain",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("seq", sa.BigInteger(), nullable=False),
        sa.Column("hash", sa.String(), nullable=False),
        sa.Column("forwarded_seq", sa.BigInteger(), nullable=False),
        sa.Column("forwarded_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("forward_error", sa.String(), nullable=True),
    )
    op.bulk_insert(chain, [{"id": 1, "seq": 0, "hash": GENESIS, "forwarded_seq": 0}])


def downgrade() -> None:
    op.drop_table("audit_chain")
    op.drop_index("ix_audit_events_seq", table_name="audit_events")
    with op.batch_alter_table("audit_events", table_kwargs=AUTOINCREMENT) as batch:
        for name in reversed(CHAIN_COLUMNS):
            batch.drop_column(name)
