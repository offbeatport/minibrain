import json
from pathlib import Path

import pytest

from minibrain.data import splits
from minibrain.data.sources import (
    READERS,
    SourceError,
    Table,
    assess,
    describe,
    example_rows,
    label_counts,
    run_query,
    stage,
    statement_tables,
    table_name_base,
)
from minibrain.data.templates import pair_template, plain_columns, template_sql
from minibrain.tasks.examples import encode_turns, single
from tests.conftest import tickets_csv

pytestmark = pytest.mark.both_stores


@pytest.fixture
def staging(tmp_path: Path) -> list[Table]:
    source = tmp_path / "tickets.csv"
    source.write_bytes(tickets_csv())
    path = tmp_path / "staging.duckdb"
    stage(source, path)
    return [Table(name="source", staging=str(path))]


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
    rows = example_rows(staging, template_sql(pair_template("text", "category"), "source"))
    assert len(rows) == 200
    with pytest.raises(SourceError):
        run_query(staging, template_sql(pair_template('text" FROM source; --', "category"), "source"), 1)


def test_templates_compile_to_chat_messages(staging: list[Table]) -> None:
    template = {"user": "Ticket: {text}\nWhy: {category}", "assistant": "{category}"}
    sql = template_sql(template, "source")
    messages, text, expected = example_rows(staging, sql, limit=1)[0]
    assert text == f"Ticket: ticket 0 about billing\nWhy: {expected}"
    assert json.loads(messages or "") == [{"role": "user", "content": text}]
    assert plain_columns(template) == (None, "category")
    assert plain_columns(pair_template("text", "category")) == ("text", "category")
    with pytest.raises(SourceError, match="names at least one column"):
        template_sql({"user": "no columns", "assistant": "{category}"}, "source")


def test_chat_rows_split_off_the_last_answer(tmp_path: Path) -> None:
    rows = [
        {"messages": [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "billing"}]},
        {
            "messages": [
                {"role": "system", "content": "short"},
                {"role": "user", "content": "a"},
                {"role": "assistant", "content": "b"},
                {"role": "user", "content": "c"},
                {"role": "assistant", "content": "bug"},
            ]
        },
        {"messages": [{"role": "user", "content": "no answer"}]},
    ]
    source = tmp_path / "chat.jsonl"
    source.write_text("".join(json.dumps(row) + "\n" for row in rows))
    path = tmp_path / "chat.duckdb"
    stage(source, path)
    tables = [Table(name="source", staging=str(path))]
    found = example_rows(tables, "SELECT messages FROM source")
    assert [(text, expected) for _, text, expected in found] == [
        ("hi", "billing"),
        ("user: a\nassistant: b\nuser: c", "bug"),
        ("", None),
    ]
    examples = splits.clean(found)
    assert [example.expected for example in examples] == ["billing", "bug"]
    assert len(examples[1].turns) == 3
    quality = assess(tables, "SELECT messages FROM source")
    assert (quality.rows, quality.empty, quality.labels) == (3, 1, 2)
    assert label_counts(tables, "SELECT messages FROM source", 10) == [("billing", 1), ("bug", 1)]
    with pytest.raises(SourceError, match="messages column"):
        example_rows(tables, "SELECT 1 AS other")


TABBED = "text\tlabel\nhello, world, again\tgreet\nbye, see you, soon\tbye\nfoo, bar, baz\tother\n"


def test_tsv_splits_on_tabs_even_when_the_text_has_commas(tmp_path: Path) -> None:
    upload = tmp_path / "chat.tsv"
    upload.write_text(TABBED)
    staged = tmp_path / "staging.duckdb"
    stage(upload, staged)
    folder = Table(name="folder", files=(str(upload),), reader=READERS[".tsv"])
    for table in (Table(name="source", staging=str(staged)), folder):
        columns, rows = describe(table)
        assert [column.name for column in columns] == ["text", "label"]
        assert rows == 3


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


def test_parse_errors_point_at_the_line_and_column() -> None:
    with pytest.raises(SourceError) as raised:
        statement_tables("\n  SELECT 'é' AS input,\n  label FORM tickets;")
    assert str(raised.value) == ('syntax error at or near "tickets"\n\nLINE 2:   label FORM tickets\n' + " " * 21 + "^")


def row(text: str, expected: str) -> splits.Row:
    return (encode_turns(single(text, expected).turns) if text else None, text, expected)


def test_split_is_disjoint_and_deterministic() -> None:
    rows = [row(f"text {index}", f"label {index % 7}") for index in range(400)] + [row("", "x"), row("text 1", "dup")]
    examples = splits.clean(rows)
    assert len(examples) == 400
    first, second = splits.split(examples), splits.split(examples)
    assert first == second
    inputs = [{example.input for example in first[name]} for name in splits.SPLITS]
    assert sum(len(group) for group in inputs) == len(set().union(*inputs))
    assert len({shot.expected for shot in first["shots"]}) == len(first["shots"]) == 7


def test_free_text_answers_are_not_a_label_set() -> None:
    examples = splits.clean([row(f"question {index}", f"answer number {index}") for index in range(120)])
    assert splits.answer_labels(examples) == []
    assert len(splits.split(examples)["shots"]) == splits.TEXT_SHOTS


def test_split_needs_enough_rows() -> None:
    with pytest.raises(splits.DatasetVersionError):
        splits.split(splits.clean([row("a", "b")] * 50))
