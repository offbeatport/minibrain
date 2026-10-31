import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"

TIMESTAMP = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "app_settings",
        sa.Column("key", sa.String(), nullable=False),
        sa.Column("value", sa.JSON(), nullable=False),
        sa.Column("updated_at", TIMESTAMP, nullable=False),
        sa.PrimaryKeyConstraint("key"),
    )
    op.create_table(
        "catalog_models",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("description", sa.String(), nullable=False),
        sa.Column("provider", sa.String(), nullable=False),
        sa.Column("repo", sa.String(), nullable=False),
        sa.Column("capabilities", sa.JSON(), nullable=False),
        sa.Column("license", sa.String(), nullable=False),
        sa.Column("license_name", sa.String(), nullable=False),
        sa.Column("license_summary", sa.String(), nullable=False),
        sa.Column("license_url", sa.String(), nullable=False),
        sa.Column("gated", sa.Boolean(), nullable=False),
        sa.Column("recommended", sa.Boolean(), nullable=False),
        sa.Column("recommendation", sa.String(), nullable=True),
        sa.Column("trainable", sa.Boolean(), nullable=False),
        sa.Column("template_kwargs", sa.JSON(), nullable=False),
        sa.Column("stop_tokens", sa.JSON(), nullable=False),
        sa.Column("popularity", sa.Integer(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("synced_at", TIMESTAMP, nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "catalog_variants",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("catalog_id", sa.String(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("label", sa.String(), nullable=False),
        sa.Column("format", sa.String(), nullable=False),
        sa.Column("precision", sa.String(), nullable=False),
        sa.Column("repo", sa.String(), nullable=False),
        sa.Column("revision", sa.String(), nullable=False),
        sa.Column("files", sa.JSON(), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("weights_bytes", sa.BigInteger(), nullable=False),
        sa.Column("runtimes", sa.JSON(), nullable=False),
        sa.Column("requires", sa.JSON(), nullable=False),
        sa.Column("latest_revision", sa.String(), nullable=True),
        sa.ForeignKeyConstraint(["catalog_id"], ["catalog_models.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "models",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("source", sa.String(), nullable=False),
        sa.Column("catalog_id", sa.String(), nullable=True),
        sa.Column("variant_id", sa.String(), nullable=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("description", sa.String(), nullable=False),
        sa.Column("tags", sa.JSON(), nullable=False),
        sa.Column("repo", sa.String(), nullable=True),
        sa.Column("revision", sa.String(), nullable=True),
        sa.Column("source_path", sa.String(), nullable=True),
        sa.Column("files", sa.JSON(), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("error", sa.String(), nullable=True),
        sa.Column("trainable", sa.Boolean(), nullable=False),
        sa.Column("template_kwargs", sa.JSON(), nullable=False),
        sa.Column("stop_tokens", sa.JSON(), nullable=False),
        sa.Column("license", sa.String(), nullable=True),
        sa.Column("license_ack_by", sa.String(), nullable=True),
        sa.Column("license_ack_at", TIMESTAMP, nullable=True),
        sa.Column("deployed", sa.Boolean(), nullable=False),
        sa.Column("archived_at", TIMESTAMP, nullable=True),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("updated_at", TIMESTAMP, nullable=False),
        sa.ForeignKeyConstraint(["catalog_id"], ["catalog_models.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["variant_id"], ["catalog_variants.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("minibrains") as batch:
        batch.add_column(sa.Column("description", sa.String(), nullable=False, server_default=""))
        batch.add_column(sa.Column("tags", sa.JSON(), nullable=False, server_default="[]"))
        batch.add_column(sa.Column("archived_at", TIMESTAMP, nullable=True))
        batch.add_column(sa.Column("updated_at", TIMESTAMP, nullable=True))
    with op.batch_alter_table("api_keys") as batch:
        batch.alter_column("minibrain_id", existing_type=sa.Integer(), nullable=True)
        batch.add_column(sa.Column("model_id", sa.String(), nullable=True))
        batch.create_foreign_key("fk_api_keys_model", "models", ["model_id"], ["id"], ondelete="CASCADE")
    with op.batch_alter_table("jobs") as batch:
        batch.add_column(sa.Column("model_id", sa.String(), nullable=True))
        batch.create_foreign_key("fk_jobs_model", "models", ["model_id"], ["id"], ondelete="SET NULL")


def downgrade() -> None:
    raise RuntimeError("0004 changes api_keys in place and has no downgrade")
