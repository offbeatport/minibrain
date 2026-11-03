import re
from pathlib import Path

import sqlalchemy as sa
from alembic import op

revision = "0018"
down_revision = "0017"

SUFFIXES = {".csv", ".tsv", ".json", ".jsonl", ".ndjson", ".parquet"}


def table_name(name: str, taken: set[str]) -> str:
    stem = Path(name).stem if Path(name).suffix.lower() in SUFFIXES else name
    base = re.sub(r"[^a-z0-9]+", "_", stem.lower()).strip("_")[:48].strip("_") or "data"
    if base[0].isdigit():
        base = f"t_{base}"
    if base == "source":
        base = "source_data"
    candidates = (base if number == 1 else f"{base}_{number}" for number in range(1, 10_000))
    chosen = next(candidate for candidate in candidates if candidate not in taken)
    taken.add(chosen)
    return chosen


def upgrade() -> None:
    with op.batch_alter_table("sources", table_kwargs={"sqlite_autoincrement": True}) as batch:
        batch.add_column(sa.Column("table_name", sa.String(), nullable=True))
    connection = op.get_bind()
    taken: set[str] = set()
    for source_id, name in connection.execute(sa.text("SELECT id, name FROM sources ORDER BY id")).all():
        connection.execute(
            sa.text("UPDATE sources SET table_name = :table WHERE id = :id"),
            {"table": table_name(name, taken), "id": source_id},
        )
    with op.batch_alter_table("sources", table_kwargs={"sqlite_autoincrement": True}) as batch:
        batch.alter_column("table_name", existing_type=sa.String(), nullable=False)
        batch.create_unique_constraint("uq_sources_table_name", ["table_name"])
    op.create_table(
        "dataset_sources",
        sa.Column("dataset_id", sa.Integer(), sa.ForeignKey("datasets.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("source_id", sa.Integer(), sa.ForeignKey("sources.id"), primary_key=True),
    )
    op.execute("INSERT INTO dataset_sources (dataset_id, source_id) SELECT id, source_id FROM datasets")
    with op.batch_alter_table("datasets", table_kwargs={"sqlite_autoincrement": True}) as batch:
        batch.alter_column("source_id", existing_type=sa.Integer(), nullable=True)


def downgrade() -> None:
    op.execute(
        "UPDATE datasets SET source_id = (SELECT min(source_id) FROM dataset_sources s "
        "WHERE s.dataset_id = datasets.id) WHERE source_id IS NULL"
    )
    op.execute("DELETE FROM datasets WHERE source_id IS NULL")
    with op.batch_alter_table("datasets", table_kwargs={"sqlite_autoincrement": True}) as batch:
        batch.alter_column("source_id", existing_type=sa.Integer(), nullable=False)
    op.drop_table("dataset_sources")
    with op.batch_alter_table("sources", table_kwargs={"sqlite_autoincrement": True}) as batch:
        batch.drop_constraint("uq_sources_table_name", type_="unique")
        batch.drop_column("table_name")
