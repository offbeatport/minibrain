import sqlalchemy as sa
from alembic import op

revision = "0041"
down_revision = "0040"

AUTOINCREMENT = {"sqlite_autoincrement": True}
CLEAR = (
    "UPDATE minibrains SET snapshot_id = NULL, current_version = NULL, last_version = -1",
    "CREATE TEMPORARY TABLE engine_jobs AS SELECT id FROM jobs "
    "WHERE kind IN ('train', 'eval', 'prepare', 'judge') OR version_id IS NOT NULL",
    "DELETE FROM job_events WHERE job_id IN (SELECT id FROM engine_jobs)",
    "DELETE FROM job_attempts WHERE job_id IN (SELECT id FROM engine_jobs)",
    "UPDATE jobs SET retry_of = NULL WHERE retry_of IN (SELECT id FROM engine_jobs)",
    "DELETE FROM jobs WHERE id IN (SELECT id FROM engine_jobs)",
    "DROP TABLE engine_jobs",
    "DELETE FROM versions",
    "UPDATE snapshots SET base_id = NULL",
    "DELETE FROM snapshots",
)


def clear_versions() -> None:
    for statement in CLEAR:
        op.execute(statement)


def upgrade() -> None:
    clear_versions()
    with op.batch_alter_table("minibrains", table_kwargs=AUTOINCREMENT) as batch:
        batch.alter_column("task", new_column_name="preset", existing_type=sa.String())
        batch.add_column(sa.Column("contract", sa.JSON(), nullable=False, server_default="{}"))
        batch.add_column(sa.Column("breaking_confirmed", sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.add_column(sa.Column("instructions", sa.String(), nullable=True))
        batch.add_column(sa.Column("graders", sa.JSON(), nullable=False, server_default="[]"))
        batch.add_column(sa.Column("promotion", sa.JSON(), nullable=False, server_default="{}"))
    op.execute("UPDATE minibrains SET preset = 'classify' WHERE preset NOT IN ('classify', 'custom')")
    with op.batch_alter_table("versions", table_kwargs=AUTOINCREMENT) as batch:
        batch.alter_column("snapshot_id", existing_type=sa.Integer(), nullable=True)
        batch.add_column(sa.Column("contract", sa.JSON(), nullable=False, server_default="{}"))
        batch.add_column(sa.Column("contract_number", sa.Integer(), nullable=False, server_default="1"))
        batch.add_column(sa.Column("instructions", sa.String(), nullable=False, server_default=""))
        batch.add_column(sa.Column("shots", sa.JSON(), nullable=False, server_default="[]"))
        batch.add_column(sa.Column("graders", sa.JSON(), nullable=False, server_default="[]"))
        batch.add_column(sa.Column("live_at", sa.DateTime(), nullable=True))
    with op.batch_alter_table("datasets", table_kwargs=AUTOINCREMENT) as batch:
        batch.drop_column("input_column")
        batch.drop_column("label_column")
        batch.add_column(sa.Column("template", sa.JSON(), nullable=True))
    with op.batch_alter_table("request_logs", table_kwargs=AUTOINCREMENT) as batch:
        batch.add_column(sa.Column("contract", sa.Integer(), nullable=True))
    op.create_table(
        "judge_scores",
        sa.Column("key", sa.String(), primary_key=True),
        sa.Column("score", sa.Float(), nullable=False),
        sa.Column("judge", sa.String(), nullable=False),
        sa.Column("judge_version", sa.String(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("judge_scores")
    clear_versions()
    with op.batch_alter_table("request_logs", table_kwargs=AUTOINCREMENT) as batch:
        batch.drop_column("contract")
    with op.batch_alter_table("datasets", table_kwargs=AUTOINCREMENT) as batch:
        batch.drop_column("template")
        batch.add_column(sa.Column("input_column", sa.String(), nullable=True))
        batch.add_column(sa.Column("label_column", sa.String(), nullable=True))
    with op.batch_alter_table("versions", table_kwargs=AUTOINCREMENT) as batch:
        for name in ("live_at", "graders", "shots", "instructions", "contract_number", "contract"):
            batch.drop_column(name)
        batch.alter_column("snapshot_id", existing_type=sa.Integer(), nullable=False)
    with op.batch_alter_table("minibrains", table_kwargs=AUTOINCREMENT) as batch:
        for name in ("promotion", "graders", "instructions", "breaking_confirmed", "contract"):
            batch.drop_column(name)
        batch.alter_column("preset", new_column_name="task", existing_type=sa.String())
