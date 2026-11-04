import os
from typing import Any

import sqlalchemy as sa
from alembic import op

from minibrain.policy import config_section

revision = "0034"
down_revision = "0033"

AUTOINCREMENT = {"sqlite_autoincrement": True}
SETTINGS = sa.table("app_settings", sa.column("key", sa.String()), sa.column("value", sa.JSON()))
MINIBRAINS = sa.table("minibrains", sa.column("request_bodies", sa.Boolean()))
DEFAULTS = {"request_logs": True, "request_bodies": False}
TRUE = {"1", "true", "yes", "on"}


def flag(value: Any) -> bool:
    return value.strip().lower() in TRUE if isinstance(value, str) else bool(value)


def effective(connection: sa.Connection, name: str) -> bool:
    variable = os.environ.get(f"MINIBRAIN_POLICY_{name.upper()}")
    if variable:
        return flag(variable)
    configured = config_section("policy")
    if name in configured:
        return flag(configured[name])
    stored = connection.execute(sa.select(SETTINGS.c.value).where(SETTINGS.c.key == f"policy.{name}")).scalar()
    return DEFAULTS[name] if stored is None else flag(stored)


def upgrade() -> None:
    connection = op.get_bind()
    kept = effective(connection, "request_logs") and effective(connection, "request_bodies")
    with op.batch_alter_table("minibrains", table_kwargs=AUTOINCREMENT) as batch:
        batch.add_column(sa.Column("request_bodies", sa.Boolean(), nullable=False, server_default=sa.false()))
    if kept:
        connection.execute(sa.update(MINIBRAINS).values(request_bodies=True))
    connection.execute(sa.delete(SETTINGS).where(SETTINGS.c.key == "policy.request_logs"))


def downgrade() -> None:
    with op.batch_alter_table("minibrains", table_kwargs=AUTOINCREMENT) as batch:
        batch.drop_column("request_bodies")
