from collections import defaultdict

import sqlalchemy as sa
from alembic import op

revision = "0038"
down_revision = "0037"

AUTOINCREMENT = {"sqlite_autoincrement": True}

SNAPSHOTS = sa.table(
    "snapshots",
    sa.column("id", sa.Integer()),
    sa.column("dataset_id", sa.Integer()),
    sa.column("feedback_rows", sa.Integer()),
    sa.column("taken_at", sa.String()),
    sa.column("created_at", sa.String()),
    sa.column("number", sa.Integer()),
    sa.column("saved", sa.Boolean()),
)


def number_versions() -> None:
    connection = op.get_bind()
    found = connection.execute(
        sa.select(SNAPSHOTS.c.id, SNAPSHOTS.c.dataset_id, SNAPSHOTS.c.taken_at, SNAPSHOTS.c.created_at).where(
            SNAPSHOTS.c.dataset_id.is_not(None), SNAPSHOTS.c.feedback_rows == 0
        )
    ).all()
    groups: dict[int, list[tuple[str, int]]] = defaultdict(list)
    for snapshot_id, dataset_id, taken_at, created_at in found:
        groups[dataset_id].append((str(taken_at or created_at), snapshot_id))
    for group in groups.values():
        for number, (_, snapshot_id) in enumerate(sorted(group), start=1):
            connection.execute(
                sa.update(SNAPSHOTS).where(SNAPSHOTS.c.id == snapshot_id).values(number=number, saved=True)
            )


def upgrade() -> None:
    with op.batch_alter_table("snapshots", table_kwargs=AUTOINCREMENT) as batch:
        batch.add_column(sa.Column("number", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("base_id", sa.Integer(), nullable=True))
        batch.create_foreign_key("fk_snapshots_base", "snapshots", ["base_id"], ["id"], ondelete="SET NULL")
        batch.drop_index("uq_snapshots_dataset_hash")
        batch.create_index("ix_snapshots_dataset_hash", ["dataset_id", "hash"])
    number_versions()
    op.create_index("uq_snapshots_dataset_number", "snapshots", ["dataset_id", "number"], unique=True)


def downgrade() -> None:
    op.drop_index("uq_snapshots_dataset_number", table_name="snapshots")
    op.execute(
        "UPDATE snapshots SET dataset_id = NULL WHERE dataset_id IS NOT NULL AND id NOT IN "
        "(SELECT min(id) FROM snapshots WHERE dataset_id IS NOT NULL GROUP BY dataset_id, hash)"
    )
    with op.batch_alter_table("snapshots", table_kwargs=AUTOINCREMENT) as batch:
        batch.drop_index("ix_snapshots_dataset_hash")
        batch.create_index("uq_snapshots_dataset_hash", ["dataset_id", "hash"], unique=True)
        batch.drop_constraint("fk_snapshots_base", type_="foreignkey")
        batch.drop_column("base_id")
        batch.drop_column("number")
