from dataclasses import dataclass
from pathlib import Path

import duckdb

from minibrain.encryption.duck import register

SAMPLE_ROWS = 20


@dataclass(frozen=True)
class LabelShift:
    label: str
    before: int
    after: int


@dataclass(frozen=True)
class Relabel:
    input: str
    before: str
    after: str


@dataclass(frozen=True)
class Diff:
    rows_before: int
    rows_after: int
    added: int
    removed: int
    relabelled: int
    unchanged: int
    labels: list[LabelShift]
    added_rows: list[tuple[str, str]]
    removed_rows: list[tuple[str, str]]
    relabelled_rows: list[Relabel]


KEYED = (
    "SELECT trim(CAST(input AS VARCHAR)) AS key, trim(CAST(input AS VARCHAR)) AS input, "
    "min(trim(CAST(expected AS VARCHAR))) AS label FROM read_parquet($path) "
    "WHERE coalesce(trim(CAST(input AS VARCHAR)), '') <> '' AND coalesce(trim(CAST(expected AS VARCHAR)), '') <> '' "
    "GROUP BY ALL"
)


def compare(before: Path | str, after: Path | str) -> Diff:
    with duckdb.connect() as connection:
        register(connection)
        connection.execute("CREATE TEMP TABLE old AS " + KEYED, {"path": str(before)})
        connection.execute("CREATE TEMP TABLE new AS " + KEYED, {"path": str(after)})
        totals = connection.execute(
            "SELECT (SELECT count(*) FROM read_parquet(?)), (SELECT count(*) FROM read_parquet(?)), "
            "count(*) FILTER (WHERE old.key IS NULL), count(*) FILTER (WHERE new.key IS NULL), "
            "count(*) FILTER (WHERE old.label <> new.label), count(*) FILTER (WHERE old.label = new.label) "
            "FROM old FULL JOIN new USING (key)",
            [str(before), str(after)],
        ).fetchone()
        labels = connection.execute(
            "WITH a AS (SELECT label, count(*) AS n FROM old GROUP BY label), "
            "b AS (SELECT label, count(*) AS n FROM new GROUP BY label) "
            "SELECT label, coalesce(a.n, 0), coalesce(b.n, 0) FROM a FULL JOIN b USING (label) "
            "ORDER BY greatest(coalesce(a.n, 0), coalesce(b.n, 0)) DESC, label"
        ).fetchall()
        added = connection.execute(
            "SELECT input, label FROM new ANTI JOIN old USING (key) ORDER BY input LIMIT ?", [SAMPLE_ROWS]
        ).fetchall()
        removed = connection.execute(
            "SELECT input, label FROM old ANTI JOIN new USING (key) ORDER BY input LIMIT ?", [SAMPLE_ROWS]
        ).fetchall()
        relabelled = connection.execute(
            "SELECT new.input, old.label, new.label FROM old JOIN new USING (key) "
            "WHERE old.label <> new.label ORDER BY new.input LIMIT ?",
            [SAMPLE_ROWS],
        ).fetchall()
    rows_before, rows_after, added_count, removed_count, relabelled_count, unchanged = totals or (0,) * 6
    return Diff(
        rows_before=int(rows_before),
        rows_after=int(rows_after),
        added=int(added_count),
        removed=int(removed_count),
        relabelled=int(relabelled_count),
        unchanged=int(unchanged),
        labels=[LabelShift(label=str(label), before=int(old), after=int(new)) for label, old, new in labels],
        added_rows=[(str(text), str(label)) for text, label in added],
        removed_rows=[(str(text), str(label)) for text, label in removed],
        relabelled_rows=[Relabel(input=str(text), before=str(old), after=str(new)) for text, old, new in relabelled],
    )
