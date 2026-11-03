import sqlalchemy as sa
from alembic import op

revision = "0022"
down_revision = "0021"

AUTOINCREMENT = {"sqlite_autoincrement": True}


def upgrade() -> None:
    with op.batch_alter_table("models") as batch:
        batch.add_column(sa.Column("path", sa.String(), nullable=True))
        batch.add_column(sa.Column("health", sa.String(), nullable=True))
        batch.add_column(sa.Column("health_detail", sa.JSON(), nullable=False, server_default="{}"))
        batch.add_column(sa.Column("verified_at", sa.DateTime(timezone=True), nullable=True))
    op.execute("UPDATE models SET verified_at = updated_at WHERE status = 'available'")
    with op.batch_alter_table("versions", table_kwargs=AUTOINCREMENT) as batch:
        batch.add_column(sa.Column("base_hash", sa.String(), nullable=True))
    with op.batch_alter_table("jobs", table_kwargs=AUTOINCREMENT) as batch:
        batch.add_column(sa.Column("error_code", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("jobs", table_kwargs=AUTOINCREMENT) as batch:
        batch.drop_column("error_code")
    with op.batch_alter_table("versions", table_kwargs=AUTOINCREMENT) as batch:
        batch.drop_column("base_hash")
    with op.batch_alter_table("models") as batch:
        batch.drop_column("verified_at")
        batch.drop_column("health_detail")
        batch.drop_column("health")
        batch.drop_column("path")
