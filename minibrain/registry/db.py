from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from alembic import command
from alembic.config import Config
from sqlalchemy import DateTime, create_engine, event, inspect
from sqlalchemy.engine import Dialect, Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.types import TypeDecorator

MIGRATIONS = Path(__file__).parent / "migrations"
BASELINE = "0001"


class Base(DeclarativeBase):
    pass


class UtcDateTime(TypeDecorator[datetime]):
    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect: Dialect) -> datetime | None:
        if value is None:
            return None
        aware = value if value.tzinfo else value.replace(tzinfo=UTC)
        utc = aware.astimezone(UTC)
        return utc.replace(tzinfo=None) if dialect.name == "sqlite" else utc

    def process_result_value(self, value: datetime | None, dialect: Dialect) -> datetime | None:
        if value is None:
            return None
        return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def is_sqlite(url: str) -> bool:
    return url.startswith("sqlite")


class MigrationError(Exception):
    pass


def sqlite_pragmas(foreign_keys: bool) -> Callable[[Any, Any], None]:
    def configure(connection: Any, _record: Any) -> None:
        cursor = connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute(f"PRAGMA foreign_keys={'ON' if foreign_keys else 'OFF'}")
        cursor.execute("PRAGMA busy_timeout=30000")
        cursor.close()

    return configure


def make_engine(url: str, foreign_keys: bool = True) -> Engine:
    if not is_sqlite(url):
        return create_engine(url, pool_pre_ping=True)
    engine = create_engine(url, connect_args={"check_same_thread": False, "timeout": 30})
    event.listen(engine, "connect", sqlite_pragmas(foreign_keys))
    return engine


def check_foreign_keys(engine: Engine) -> None:
    if engine.dialect.name != "sqlite":
        return
    with engine.connect() as connection:
        broken = connection.exec_driver_sql("PRAGMA foreign_key_check").fetchall()
    if broken:
        raise MigrationError(f"foreign keys broken after migrating: {broken[:5]}")


def migrate(url: str) -> None:
    engine = make_engine(url, foreign_keys=False)
    config = Config()
    config.set_main_option("script_location", str(MIGRATIONS))
    config.attributes["engine"] = engine
    tables = set(inspect(engine).get_table_names())
    if "minibrains" in tables and "alembic_version" not in tables:
        command.stamp(config, BASELINE)
    command.upgrade(config, "head")
    check_foreign_keys(engine)
    engine.dispose()


def make_sessions(url: str) -> sessionmaker[Session]:
    return sessionmaker(make_engine(url), expire_on_commit=False)
