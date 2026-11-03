import sqlalchemy as sa
from alembic import op

revision = "0028"
down_revision = "0027"

AUTOINCREMENT = {"sqlite_autoincrement": True}


def upgrade() -> None:
    op.create_table(
        "dataset_folders",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("parent_id", sa.Integer(), sa.ForeignKey("dataset_folders.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sqlite_autoincrement=True,
    )
    with op.batch_alter_table("datasets", table_kwargs=AUTOINCREMENT) as batch:
        batch.add_column(sa.Column("folder_id", sa.Integer(), nullable=True))
        batch.create_foreign_key("fk_datasets_folder", "dataset_folders", ["folder_id"], ["id"], ondelete="SET NULL")


def downgrade() -> None:
    with op.batch_alter_table("datasets", table_kwargs=AUTOINCREMENT) as batch:
        batch.drop_constraint("fk_datasets_folder", type_="foreignkey")
        batch.drop_column("folder_id")
    op.drop_table("dataset_folders")
