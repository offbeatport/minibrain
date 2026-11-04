from alembic import op

revision = "0037"
down_revision = "0036"


def upgrade() -> None:
    op.execute("DELETE FROM teardowns WHERE kind = 'remove_files'")
    op.execute("DELETE FROM app_settings WHERE key = 'models.cache'")


def downgrade() -> None:
    pass
