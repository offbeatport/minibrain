import sqlalchemy as sa
from alembic import op

revision = "0021"
down_revision = "0020"

AUTOINCREMENT = {"sqlite_autoincrement": True}


def upgrade() -> None:
    with op.batch_alter_table("minibrains", table_kwargs=AUTOINCREMENT) as batch:
        batch.add_column(sa.Column("snapshot_id", sa.Integer(), nullable=True))
        batch.create_foreign_key("fk_minibrains_snapshot", "snapshots", ["snapshot_id"], ["id"], ondelete="SET NULL")
    op.execute(
        "UPDATE jobs SET status = 'cancelled', error = 'snapshots are now taken without a job' "
        "WHERE kind = 'prepare' AND status IN ('queued', 'running')"
    )


def downgrade() -> None:
    with op.batch_alter_table("minibrains", table_kwargs=AUTOINCREMENT) as batch:
        batch.drop_constraint("fk_minibrains_snapshot", type_="foreignkey")
        batch.drop_column("snapshot_id")
