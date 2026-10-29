from pathlib import Path

import pytest

from minibrain.data import snapshot
from minibrain.data.sources import SourceError, labelled_rows, mapping_sql, run_query, stage
from minibrain.tasks.classify import build_messages, parse_label, score
from tests.conftest import tickets_csv


@pytest.fixture
def staging(tmp_path: Path) -> Path:
    source = tmp_path / "tickets.csv"
    source.write_bytes(tickets_csv())
    path = tmp_path / "staging.duckdb"
    stage(source, path)
    return path


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT * FROM read_csv_auto('/etc/hosts')",
        "CREATE TABLE copy AS SELECT * FROM source",
        "SELECT 1; DROP TABLE source",
        "SET enable_external_access = true",
        "ATTACH '/tmp/other.duckdb' AS other",
    ],
)
def test_user_sql_is_sandboxed(staging: Path, sql: str) -> None:
    with pytest.raises(SourceError):
        run_query(staging, sql, 5)


def test_mapping_quotes_identifiers(staging: Path) -> None:
    rows = labelled_rows(staging, mapping_sql("text", "category"))
    assert len(rows) == 200
    with pytest.raises(SourceError):
        run_query(staging, mapping_sql('text" FROM source; --', "category"), 1)


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
