import sqlalchemy as sa
from alembic import op

revision = "0027"
down_revision = "0026"

AUTOINCREMENT = {"sqlite_autoincrement": True}


def upgrade() -> None:
    op.create_table(
        "connections",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False, unique=True),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("config", sa.JSON(), nullable=False),
        sa.Column("secret", sa.String(), nullable=True),
        sa.Column("secret_ref", sa.JSON(), nullable=True),
        sa.Column("origin", sa.String(), nullable=False, server_default="ui"),
        sa.Column("problem", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sqlite_autoincrement=True,
    )
    with op.batch_alter_table("sources", table_kwargs=AUTOINCREMENT) as batch:
        batch.add_column(sa.Column("connection_id", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("query", sa.String(), nullable=True))
        batch.add_column(sa.Column("change_column", sa.String(), nullable=True))
        batch.create_foreign_key("fk_sources_connection", "connections", ["connection_id"], ["id"])
    with op.batch_alter_table("models") as batch:
        batch.add_column(sa.Column("connection_id", sa.Integer(), nullable=True))
        batch.create_foreign_key("fk_models_connection", "connections", ["connection_id"], ["id"], ondelete="SET NULL")


def downgrade() -> None:
    with op.batch_alter_table("models") as batch:
        batch.drop_constraint("fk_models_connection", type_="foreignkey")
        batch.drop_column("connection_id")
    op.execute(
        "DELETE FROM dataset_sources WHERE source_id IN (SELECT id FROM sources WHERE connection_id IS NOT NULL)"
    )
    op.execute(
        "UPDATE datasets SET source_id = NULL WHERE source_id IN "
        "(SELECT id FROM sources WHERE connection_id IS NOT NULL)"
    )
    op.execute("DELETE FROM sources WHERE connection_id IS NOT NULL")
    with op.batch_alter_table("sources", table_kwargs=AUTOINCREMENT) as batch:
        batch.drop_constraint("fk_sources_connection", type_="foreignkey")
        batch.drop_column("change_column")
        batch.drop_column("query")
        batch.drop_column("connection_id")
    op.drop_table("connections")
