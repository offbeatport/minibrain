import re
from pathlib import Path

from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import Engine, create_engine, text

from minibrain.registry.audit_chain import GENESIS, HEAD
from minibrain.registry.db import migrate
from minibrain.registry.models import Base

MASTER = "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != 'alembic_version'"
CONSTRAINTS = ("PRIMARY KEY", "FOREIGN KEY", "UNIQUE", "CONSTRAINT", "CHECK")
Shape = tuple[str, tuple[str, ...], tuple[str, ...]]


def migrated(tmp_path: Path) -> Engine:
    url = f"sqlite:///{tmp_path / 'migrated.db'}"
    migrate(url)
    return create_engine(url)


def built(tmp_path: Path) -> Engine:
    engine = create_engine(f"sqlite:///{tmp_path / 'built.db'}")
    Base.metadata.create_all(engine)
    return engine


def parts(body: str) -> list[str]:
    found, depth, current = [], 0, ""
    for char in body:
        depth += {"(": 1, ")": -1}.get(char, 0)
        if char == "," and depth == 0:
            found.append(current.strip())
            current = ""
        else:
            current += char
    return [*found, current.strip()]


def shape(sql: str) -> Shape:
    flat = re.sub(r"\s+", " ", sql).strip()
    head, _, rest = flat.partition("(")
    if not head.startswith("CREATE TABLE"):
        return flat, (), ()
    items = parts(rest.rsplit(")", 1)[0])
    columns = tuple(item for item in items if not item.startswith(CONSTRAINTS))
    constraints = tuple(sorted(item for item in items if item.startswith(CONSTRAINTS)))
    return head.strip(), columns, constraints


def statements(engine: Engine) -> dict[tuple[str, str], Shape]:
    with engine.connect() as connection:
        rows = connection.execute(text(MASTER)).all()
    return {(kind, name): shape(sql or "") for kind, name, sql in rows}


def test_the_baseline_builds_the_orm_schema(tmp_path: Path) -> None:
    engine = migrated(tmp_path)
    with engine.connect() as connection:
        context = MigrationContext.configure(connection, opts={"compare_type": True, "compare_server_default": True})
        assert compare_metadata(context, Base.metadata) == []
    assert statements(engine) == statements(built(tmp_path))


def test_the_baseline_seeds_the_audit_chain_head(tmp_path: Path) -> None:
    with migrated(tmp_path).connect() as connection:
        head = connection.execute(text("SELECT id, seq, hash, forwarded_seq FROM audit_chain")).all()
    assert head == [(HEAD, 0, GENESIS, 0)]
