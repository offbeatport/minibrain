from pathlib import Path

import pytest

from minibrain.data import snapshot
from minibrain.data.sources import (
    SourceError,
    Table,
    labelled_rows,
    mapping_sql,
    run_query,
    stage,
    statement_tables,
    table_name_base,
)
from minibrain.tasks.classify import build_messages, parse_label, score
from tests.conftest import tickets_csv


@pytest.fixture
def staging(tmp_path: Path) -> list[Table]:
    source = tmp_path / "tickets.csv"
    source.write_bytes(tickets_csv())
    path = tmp_path / "staging.duckdb"
    stage(source, path)
    return [Table(name="source", staging=path)]


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT * FROM read_csv_auto('/etc/hosts')",
        "CREATE TABLE copy AS SELECT * FROM source",
        "SELECT 1; DROP TABLE source",
        "SET enable_external_access = true",
        "ATTACH '/tmp/other.duckdb' AS other",
        "COPY (SELECT 1) TO '/tmp/minibrain-out.csv'",
        "SELECT 1) AS q; COPY (SELECT 1) TO '/tmp/minibrain-out.csv'; SELECT * FROM (SELECT 1",
    ],
)
def test_user_sql_is_sandboxed(staging: list[Table], sql: str) -> None:
    with pytest.raises(SourceError):
        run_query(staging, sql, 5)


def test_mapping_quotes_identifiers(staging: list[Table]) -> None:
    rows = labelled_rows(staging, mapping_sql("text", "category"))
    assert len(rows) == 200
    with pytest.raises(SourceError):
        run_query(staging, mapping_sql('text" FROM source; --', "category"), 1)


def test_table_names_are_readable_identifiers() -> None:
    assert table_name_base("Support tickets (2025).csv") == "support_tickets_2025"
    assert table_name_base("2025 export.parquet") == "t_2025_export"
    assert table_name_base("select") == "select_data"
    assert table_name_base("source") == "source_data"
    assert table_name_base("???") == "data"


def test_statement_tables_reads_every_table_a_query_names() -> None:
    sql = (
        "WITH recent AS (SELECT * FROM tickets) SELECT r.text AS input, l.name AS label FROM recent r "
        'JOIN "Labels" l USING (id) WHERE id IN (SELECT id FROM extra)'
    )
    assert statement_tables(sql) == {"recent", "tickets", "labels", "extra"}
    with pytest.raises(SourceError, match="one SELECT"):
        statement_tables("SELECT 1; SELECT 2")
    with pytest.raises(SourceError, match="single SELECT"):
        statement_tables("DROP TABLE tickets")


def test_split_is_disjoint_and_deterministic() -> None:
    rows = [(f"text {index}", f"label {index % 7}") for index in range(400)] + [("", "x"), ("text 1", "dup")]
    examples = snapshot.clean(rows)
    assert len(examples) == 400
    first, second = snapshot.split(examples), snapshot.split(examples)
    assert snapshot.content_hash(first) == snapshot.content_hash(second)
    inputs = [{example.input for example in first[name]} for name in snapshot.SPLITS]
    assert sum(len(group) for group in inputs) == len(set().union(*inputs))
    assert len({shot.label for shot in first["shots"]}) == len(first["shots"]) == 7


def test_split_needs_enough_rows() -> None:
    with pytest.raises(snapshot.SnapshotError):
        snapshot.split(snapshot.clean([("a", "b")] * 50))


def test_parse_label_returns_canonical_case() -> None:
    labels = ["Billing", "card_arrival"]
    assert parse_label(" billing\n", labels) == "Billing"
    assert parse_label("`card_arrival`.", labels) == "card_arrival"
    assert parse_label("something else", labels) is None


def test_score_counts_invalid_as_wrong() -> None:
    examples = [snapshot.Example("a", "x"), snapshot.Example("b", "y"), snapshot.Example("c", "x")]
    result = score(examples, ["x", "nonsense", "y"], ["x", "y"])
    assert result["accuracy"] == pytest.approx(1 / 3)
    assert result["invalid_rate"] == pytest.approx(1 / 3)
    assert len(result["mistakes"]) == 2


def test_prompt_only_lists_labels_and_shots() -> None:
    shots = [snapshot.Example("where is my card", "card_arrival")]
    messages = build_messages("prompt", "hello", ["card_arrival", "billing"], shots)
    assert "billing" in messages[0]["content"]
    assert messages[1:] == [
        {"role": "user", "content": "where is my card"},
        {"role": "assistant", "content": "card_arrival"},
        {"role": "user", "content": "hello"},
    ]
    assert len(build_messages("lora", "hello", ["billing"], shots)) == 2
