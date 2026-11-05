import sqlalchemy as sa
from alembic import op

revision = "0042"
down_revision = "0041"

AUTOINCREMENT = {"sqlite_autoincrement": True}


def upgrade() -> None:
    with op.batch_alter_table("minibrains", table_kwargs=AUTOINCREMENT) as batch:
        batch.drop_constraint("fk_minibrains_snapshot", type_="foreignkey")
        batch.drop_column("snapshot_id")
    op.execute("DELETE FROM snapshots WHERE artifact_id IS NULL OR minibrain_id IS NOT NULL")
    with op.batch_alter_table("snapshots", table_kwargs=AUTOINCREMENT) as batch:
        batch.drop_column("minibrain_id")
        batch.drop_column("directory")
        batch.alter_column("artifact_id", existing_type=sa.String(), nullable=False)
    with op.batch_alter_table("versions", table_kwargs=AUTOINCREMENT) as batch:
        batch.drop_column("adapter_dir")
    op.execute("DELETE FROM models WHERE status = 'evicted'")
    with op.batch_alter_table("models") as batch:
        batch.drop_column("evicted_at")
        batch.drop_column("evicted_by")
        batch.drop_column("pinned")


def downgrade() -> None:
    with op.batch_alter_table("models") as batch:
        batch.add_column(sa.Column("pinned", sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.add_column(sa.Column("evicted_by", sa.String(), nullable=True))
        batch.add_column(sa.Column("evicted_at", sa.DateTime(timezone=True), nullable=True))
    with op.batch_alter_table("versions", table_kwargs=AUTOINCREMENT) as batch:
        batch.add_column(sa.Column("adapter_dir", sa.String(), nullable=True))
    with op.batch_alter_table("snapshots", table_kwargs=AUTOINCREMENT) as batch:
        batch.alter_column("artifact_id", existing_type=sa.String(), nullable=True)
        batch.add_column(sa.Column("directory", sa.String(), nullable=True))
        batch.add_column(sa.Column("minibrain_id", sa.Integer(), nullable=True))
        batch.create_foreign_key("fk_snapshots_minibrain", "minibrains", ["minibrain_id"], ["id"], ondelete="CASCADE")
    with op.batch_alter_table("minibrains", table_kwargs=AUTOINCREMENT) as batch:
        batch.add_column(sa.Column("snapshot_id", sa.Integer(), nullable=True))
        batch.create_foreign_key("fk_minibrains_snapshot", "snapshots", ["snapshot_id"], ["id"], ondelete="SET NULL")
