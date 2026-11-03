import sqlalchemy as sa
from alembic import op

revision = "0020"
down_revision = "0019"

TIMESTAMP = sa.DateTime(timezone=True)
AUTOINCREMENT = {"sqlite_autoincrement": True}


def upgrade() -> None:
    with op.batch_alter_table("snapshots", table_kwargs=AUTOINCREMENT) as batch:
        batch.alter_column("minibrain_id", existing_type=sa.Integer(), nullable=True)
        batch.add_column(sa.Column("dataset_id", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("rows", sa.Integer(), nullable=False, server_default="0"))
        batch.add_column(sa.Column("size", sa.BigInteger(), nullable=False, server_default="0"))
        batch.add_column(sa.Column("fingerprints", sa.JSON(), nullable=True))
        batch.add_column(sa.Column("sql", sa.String(), nullable=True))
        batch.add_column(sa.Column("saved", sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.add_column(sa.Column("taken_at", TIMESTAMP, nullable=True))
        batch.create_foreign_key("fk_snapshots_dataset", "datasets", ["dataset_id"], ["id"], ondelete="SET NULL")
        batch.create_index("uq_snapshots_dataset_hash", ["dataset_id", "hash"], unique=True)


def downgrade() -> None:
    op.execute(
        "UPDATE snapshots SET minibrain_id = (SELECT min(v.minibrain_id) FROM versions v "
        "WHERE v.snapshot_id = snapshots.id) WHERE minibrain_id IS NULL"
    )
    op.execute("DELETE FROM snapshots WHERE minibrain_id IS NULL")
    with op.batch_alter_table("snapshots", table_kwargs=AUTOINCREMENT) as batch:
        batch.alter_column("minibrain_id", existing_type=sa.Integer(), nullable=False)
        batch.drop_index("uq_snapshots_dataset_hash")
        batch.drop_constraint("fk_snapshots_dataset", type_="foreignkey")
        for column in ("taken_at", "saved", "sql", "fingerprints", "size", "rows", "dataset_id"):
            batch.drop_column(column)
