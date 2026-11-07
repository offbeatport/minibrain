import sqlalchemy as sa
from alembic import op

revision = "0010"
down_revision = "0009"

KEEP = {"recreate": "always", "table_kwargs": {"sqlite_autoincrement": True}}


def upgrade() -> None:
    with op.batch_alter_table("versions") as batch:
        batch.add_column(sa.Column("base_model", sa.String(), nullable=True))
    op.execute("UPDATE versions SET base_model = (SELECT base_model FROM models WHERE models.id = versions.model_id)")
    with op.batch_alter_table("versions", **KEEP) as batch:
        batch.alter_column("base_model", existing_type=sa.String(), nullable=False)
    with op.batch_alter_table("models") as batch:
        batch.add_column(sa.Column("deployed_base", sa.String(), nullable=True))
    op.execute("UPDATE models SET deployed_base = base_model WHERE deployed")


def downgrade() -> None:
    with op.batch_alter_table("models") as batch:
        batch.drop_column("deployed_base")
    with op.batch_alter_table("versions", **KEEP) as batch:
        batch.drop_column("base_model")
