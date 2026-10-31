from alembic import context
from sqlalchemy.engine import Engine

from minibrain.registry import models

engine: Engine = context.config.attributes["engine"]

with engine.connect() as connection:
    context.configure(
        connection=connection,
        target_metadata=models.Base.metadata,
        render_as_batch=connection.dialect.name == "sqlite",
    )
    with context.begin_transaction():
        context.run_migrations()
    connection.commit()
