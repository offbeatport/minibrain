import sqlalchemy as sa
from alembic import op

revision = "0008"
down_revision = "0007"


def link(target: str, column: str, ondelete: str) -> sa.Column:
    return sa.Column(column, sa.Integer(), sa.ForeignKey(target, ondelete=ondelete), nullable=True)


JOB_LINKS = {"model_id": "models.id", "version_id": "versions.id"}
KEEP = {"recreate": "always", "table_kwargs": {"sqlite_autoincrement": True}}


def relink(ondelete: str) -> None:
    jobs = tuple(link(target, column, ondelete) for column, target in JOB_LINKS.items())
    with op.batch_alter_table("jobs", reflect_args=jobs, **KEEP) as batch:
        if ondelete == "SET NULL":
            batch.add_column(sa.Column("model_slug", sa.String(), nullable=True))
            batch.add_column(sa.Column("model_name", sa.String(), nullable=True))
            batch.add_column(sa.Column("version_number", sa.Integer(), nullable=True))
            batch.add_column(sa.Column("base_model_key", sa.String(), nullable=True))
        else:
            batch.drop_column("base_model_key")
            batch.drop_column("version_number")
            batch.drop_column("model_name")
            batch.drop_column("model_slug")
    logs = (link("models.id", "model_id", ondelete),)
    with op.batch_alter_table("request_logs", reflect_args=logs, **KEEP) as batch:
        if ondelete == "SET NULL":
            batch.add_column(sa.Column("model_slug", sa.String(), nullable=True))
            batch.add_column(sa.Column("model_name", sa.String(), nullable=True))
        else:
            batch.drop_column("model_name")
            batch.drop_column("model_slug")


BACKFILL = (
    "UPDATE jobs SET model_slug = (SELECT slug FROM models WHERE models.id = jobs.model_id), "
    "model_name = (SELECT name FROM models WHERE models.id = jobs.model_id) WHERE model_id IS NOT NULL",
    "UPDATE jobs SET version_number = (SELECT number FROM versions WHERE versions.id = jobs.version_id) "
    "WHERE version_id IS NOT NULL",
    "UPDATE jobs SET base_model_key = base_model_id WHERE base_model_id IS NOT NULL",
    "UPDATE request_logs SET model_slug = (SELECT slug FROM models WHERE models.id = request_logs.model_id), "
    "model_name = (SELECT name FROM models WHERE models.id = request_logs.model_id) WHERE model_id IS NOT NULL",
)


def upgrade() -> None:
    relink("SET NULL")
    op.create_index("ix_request_logs_slug", "request_logs", ["model_slug", "id"])
    for statement in BACKFILL:
        op.execute(statement)


def downgrade() -> None:
    op.execute("DELETE FROM jobs WHERE model_id IS NULL AND model_slug IS NOT NULL")
    op.execute("DELETE FROM request_logs WHERE model_id IS NULL AND model_slug IS NOT NULL")
    op.drop_index("ix_request_logs_slug", table_name="request_logs")
    relink("CASCADE")
