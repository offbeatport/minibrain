from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import op

from minibrain.registry.db import UtcDateTime

revision = "0009"
down_revision = "0008"

SETTINGS = sa.table(
    "app_settings",
    sa.column("key", sa.String()),
    sa.column("value", sa.JSON()),
    sa.column("updated_at", UtcDateTime()),
)
OLD = "policy.allow_unreviewed_licences"
NEW = "policy.licence_mode"


def upgrade() -> None:
    connection = op.get_bind()
    allowed = connection.execute(sa.select(SETTINGS.c.value).where(SETTINGS.c.key == OLD)).scalar()
    if allowed is True:
        connection.execute(sa.insert(SETTINGS).values(key=NEW, value="all", updated_at=datetime.now(UTC)))
    connection.execute(sa.delete(SETTINGS).where(SETTINGS.c.key == OLD))


def downgrade() -> None:
    connection = op.get_bind()
    mode = connection.execute(sa.select(SETTINGS.c.value).where(SETTINGS.c.key == NEW)).scalar()
    if mode == "all":
        connection.execute(sa.insert(SETTINGS).values(key=OLD, value=True, updated_at=datetime.now(UTC)))
    connection.execute(sa.delete(SETTINGS).where(SETTINGS.c.key == NEW))
