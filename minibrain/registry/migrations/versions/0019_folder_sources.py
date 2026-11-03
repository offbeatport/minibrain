import sqlalchemy as sa
from alembic import op

revision = "0019"
down_revision = "0018"


def upgrade() -> None:
    with op.batch_alter_table("sources", table_kwargs={"sqlite_autoincrement": True}) as batch:
        batch.add_column(sa.Column("kind", sa.String(), nullable=False, server_default="upload"))
        batch.add_column(sa.Column("path", sa.String(), nullable=True))
        batch.add_column(sa.Column("format", sa.String(), nullable=True))
        batch.alter_column("artifact_id", existing_type=sa.String(), nullable=True)


def downgrade() -> None:
    op.execute("DELETE FROM dataset_sources WHERE source_id IN (SELECT id FROM sources WHERE artifact_id IS NULL)")
    op.execute("UPDATE datasets SET source_id = NULL WHERE source_id IN (SELECT id FROM sources WHERE kind = 'folder')")
    op.execute("DELETE FROM sources WHERE artifact_id IS NULL")
    with op.batch_alter_table("sources", table_kwargs={"sqlite_autoincrement": True}) as batch:
        batch.alter_column("artifact_id", existing_type=sa.String(), nullable=False)
        batch.drop_column("format")
        batch.drop_column("path")
        batch.drop_column("kind")
