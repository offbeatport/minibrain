import sqlalchemy as sa
from alembic import op

revision = "0013"
down_revision = "0012"


def upgrade() -> None:
    op.create_table(
        "api_key_scopes",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("key_id", sa.Integer(), sa.ForeignKey("api_keys.id", ondelete="CASCADE"), nullable=False),
        sa.Column("minibrain_id", sa.Integer(), sa.ForeignKey("minibrains.id", ondelete="CASCADE"), nullable=True),
        sa.Column("model_id", sa.String(), sa.ForeignKey("models.id", ondelete="CASCADE"), nullable=True),
        sa.UniqueConstraint("key_id", "minibrain_id", "model_id"),
        sqlite_autoincrement=True,
    )
    op.execute(
        "INSERT INTO api_key_scopes (key_id, minibrain_id, model_id) "
        "SELECT id, minibrain_id, model_id FROM api_keys WHERE minibrain_id IS NOT NULL OR model_id IS NOT NULL"
    )
    with op.batch_alter_table("api_keys", table_kwargs={"sqlite_autoincrement": True}) as batch:
        batch.drop_constraint("fk_api_keys_model", type_="foreignkey")
        batch.drop_column("model_id")
        batch.drop_column("minibrain_id")


def downgrade() -> None:
    with op.batch_alter_table("api_keys", table_kwargs={"sqlite_autoincrement": True}) as batch:
        batch.add_column(sa.Column("minibrain_id", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("model_id", sa.String(), nullable=True))
        batch.create_foreign_key("fk_api_keys_minibrain", "minibrains", ["minibrain_id"], ["id"], ondelete="CASCADE")
        batch.create_foreign_key("fk_api_keys_model", "models", ["model_id"], ["id"], ondelete="CASCADE")
    op.execute(
        "UPDATE api_keys SET minibrain_id = (SELECT minibrain_id FROM api_key_scopes s WHERE s.key_id = api_keys.id "
        "ORDER BY s.id LIMIT 1), model_id = (SELECT model_id FROM api_key_scopes s WHERE s.key_id = api_keys.id "
        "ORDER BY s.id LIMIT 1)"
    )
    op.drop_table("api_key_scopes")
