import sqlalchemy as sa
from alembic import op

revision = "0014"
down_revision = "0013"

RESERVE_CUSTOM = (
    "INSERT INTO reserved_names (name, kind, model_name, deleted_at, deleted_by) "
    "SELECT gone.name, 'custom', COALESCE(gone.model_name, gone.name), "
    "COALESCE((SELECT MAX(audit.at) FROM audit_events audit WHERE audit.target = gone.name "
    "AND audit.action IN ('model.delete', 'model.delete_finished')), gone.seen), "
    "COALESCE((SELECT audit.actor FROM audit_events audit WHERE audit.target = gone.name "
    "AND audit.action = 'model.delete' ORDER BY audit.id DESC LIMIT 1), 'system') "
    "FROM (SELECT name, MAX(model_name) AS model_name, MAX(at) AS seen FROM ("
    "SELECT model_slug AS name, model_name, COALESCE(finished_at, created_at) AS at FROM jobs "
    "WHERE model_slug IS NOT NULL AND model_id IS NULL "
    "UNION ALL SELECT model_slug AS name, model_name, at FROM request_logs "
    "WHERE model_slug IS NOT NULL AND model_id IS NULL"
    ") found GROUP BY name) gone "
    "WHERE gone.name NOT IN (SELECT slug FROM models) "
    "AND gone.name NOT IN (SELECT id FROM base_models) "
    "AND gone.name NOT IN (SELECT name FROM reserved_names)"
)
RESERVE_BASE = (
    "INSERT INTO reserved_names (name, kind, model_name, deleted_at, deleted_by) "
    "SELECT gone.name, 'base', COALESCE(gone.model_name, gone.name), "
    "COALESCE((SELECT MAX(audit.at) FROM audit_events audit WHERE audit.target = gone.name "
    "AND audit.action IN ('model.delete', 'model.delete_finished')), gone.seen), "
    "COALESCE((SELECT audit.actor FROM audit_events audit WHERE audit.target = gone.name "
    "AND audit.action = 'model.delete' ORDER BY audit.id DESC LIMIT 1), 'system') "
    "FROM (SELECT name, MAX(model_name) AS model_name, MAX(at) AS seen FROM ("
    "SELECT base_model_key AS name, NULL AS model_name, COALESCE(finished_at, created_at) AS at FROM jobs "
    "WHERE base_model_key IS NOT NULL AND base_model_id IS NULL "
    "UNION ALL SELECT model AS name, model_name, at FROM request_logs "
    "WHERE model_slug IS NULL AND model_id IS NULL AND model_name IS NOT NULL"
    ") found GROUP BY name) gone "
    "WHERE gone.name NOT IN (SELECT slug FROM models) "
    "AND gone.name NOT IN (SELECT id FROM base_models) "
    "AND gone.name NOT IN (SELECT name FROM reserved_names)"
)


def upgrade() -> None:
    op.create_table(
        "reserved_names",
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("model_name", sa.String(), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_by", sa.String(), nullable=False),
        sa.PrimaryKeyConstraint("name"),
    )
    op.execute(RESERVE_CUSTOM)
    op.execute(RESERVE_BASE)


def downgrade() -> None:
    op.drop_table("reserved_names")
