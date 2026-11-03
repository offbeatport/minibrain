from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import op

revision = "0012"
down_revision = "0011"

TIMESTAMP = sa.DateTime(timezone=True)
MOVED = ("source_file", "source_artifact_id", "input_column", "label_column", "sql")
DOWNGRADE_COPY = (
    "UPDATE minibrains SET source_file = (SELECT s.filename FROM datasets d JOIN sources s ON s.id = d.source_id "
    "WHERE d.id = minibrains.dataset_id)",
    "UPDATE minibrains SET source_artifact_id = (SELECT s.artifact_id FROM datasets d JOIN sources s "
    "ON s.id = d.source_id WHERE d.id = minibrains.dataset_id)",
    "UPDATE minibrains SET input_column = (SELECT d.input_column FROM datasets d WHERE d.id = minibrains.dataset_id)",
    "UPDATE minibrains SET label_column = (SELECT d.label_column FROM datasets d WHERE d.id = minibrains.dataset_id)",
    "UPDATE minibrains SET sql = (SELECT d.sql FROM datasets d WHERE d.id = minibrains.dataset_id)",
)


def upgrade() -> None:
    op.create_table(
        "sources",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("filename", sa.String(), nullable=False),
        sa.Column("artifact_id", sa.String(), sa.ForeignKey("artifacts.id"), nullable=False),
        sa.Column("size", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sqlite_autoincrement=True,
    )
    op.create_table(
        "datasets",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("slug", sa.String(), nullable=False, unique=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("source_id", sa.Integer(), sa.ForeignKey("sources.id"), nullable=False),
        sa.Column("input_column", sa.String(), nullable=True),
        sa.Column("label_column", sa.String(), nullable=True),
        sa.Column("sql", sa.String(), nullable=True),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("updated_at", TIMESTAMP, nullable=False),
        sqlite_autoincrement=True,
    )
    with op.batch_alter_table("minibrains", table_kwargs={"sqlite_autoincrement": True}) as batch:
        batch.add_column(sa.Column("dataset_id", sa.Integer(), nullable=True))
        batch.create_foreign_key("fk_minibrains_dataset", "datasets", ["dataset_id"], ["id"], ondelete="SET NULL")
    connection = op.get_bind()
    moment = datetime.now(UTC)
    rows = connection.execute(
        sa.text(
            "SELECT m.id, m.slug, m.name, m.source_file, m.source_artifact_id, m.input_column, m.label_column, m.sql, "
            "a.size FROM minibrains m JOIN artifacts a ON a.id = m.source_artifact_id"
        )
    ).all()
    for minibrain_id, slug, name, filename, artifact, input_column, label_column, sql, size in rows:
        source = connection.execute(
            sa.text(
                "INSERT INTO sources (name, filename, artifact_id, size, created_at) "
                "VALUES (:name, :filename, :artifact, :size, :at) RETURNING id"
            ),
            {
                "name": filename or name,
                "filename": filename or "data",
                "artifact": artifact,
                "size": size or 0,
                "at": moment,
            },
        ).scalar_one()
        dataset = connection.execute(
            sa.text(
                "INSERT INTO datasets (slug, name, source_id, input_column, label_column, sql, created_at, updated_at) "
                "VALUES (:slug, :name, :source, :input, :label, :sql, :at, :at) RETURNING id"
            ),
            {
                "slug": slug,
                "name": name,
                "source": source,
                "input": input_column,
                "label": label_column,
                "sql": sql,
                "at": moment,
            },
        ).scalar_one()
        connection.execute(
            sa.text("UPDATE minibrains SET dataset_id = :dataset WHERE id = :id"),
            {"dataset": dataset, "id": minibrain_id},
        )
    with op.batch_alter_table("minibrains", table_kwargs={"sqlite_autoincrement": True}) as batch:
        for column in MOVED:
            batch.drop_column(column)


def downgrade() -> None:
    with op.batch_alter_table("minibrains", table_kwargs={"sqlite_autoincrement": True}) as batch:
        batch.add_column(sa.Column("source_file", sa.String(), nullable=True))
        batch.add_column(sa.Column("source_artifact_id", sa.String(), nullable=True))
        batch.add_column(sa.Column("input_column", sa.String(), nullable=True))
        batch.add_column(sa.Column("label_column", sa.String(), nullable=True))
        batch.add_column(sa.Column("sql", sa.String(), nullable=True))
    for statement in DOWNGRADE_COPY:
        op.execute(statement)
    with op.batch_alter_table("minibrains", table_kwargs={"sqlite_autoincrement": True}) as batch:
        batch.drop_constraint("fk_minibrains_dataset", type_="foreignkey")
        batch.drop_column("dataset_id")
    op.drop_table("datasets")
    op.drop_table("sources")
