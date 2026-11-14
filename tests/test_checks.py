from minibrain.data.checks import CheckLimits, Finding, run_checks
from minibrain.data.splits import Row, clean, split
from minibrain.tasks.examples import Example, Turn, encode_turns, single
from tests.conftest import Harness, tickets_csv


def by_check(findings: list[Finding]) -> dict[str, Finding]:
    return {finding.check: finding for finding in findings}


def labelled(count: int, labels: int = 4) -> list[tuple[str | None, str | None]]:
    return [(f"message number {index}", f"label {index % labels}") for index in range(count)]


def examples_of(rows: list[tuple[str | None, str | None]]) -> list[Row]:
    return [(encode_turns(single(text, label).turns), text, label) for text, label in rows if text and label]


def test_clean_rows_pass_every_check() -> None:
    rows = labelled(200)
    found = by_check(run_checks(rows, split(clean(examples_of(rows))), CheckLimits()))
    assert {name: finding.status for name, finding in found.items()} == {
        "empty": "ok",
        "single_label": "ok",
        "duplicates": "ok",
        "conflicts": "ok",
        "balance": "ok",
        "leakage": "ok",
        "length": "ok",
        "personal_data": "ok",
    }
    assert "can miss names and addresses" in found["personal_data"].detail


def test_hard_stops_block_an_empty_or_single_label_dataset() -> None:
    empty = by_check(run_checks([("", "a"), (None, None)], None, CheckLimits()))
    assert empty["empty"].status == "blocked"
    single = by_check(run_checks([(f"row {index}", "billing") for index in range(150)], None, CheckLimits()))
    assert single["single_label"].status == "blocked" and "'billing'" in single["single_label"].detail


def test_duplicates_conflicts_and_lengths_are_counted() -> None:
    extra: list[tuple[str | None, str | None]] = [
        ("message number 1", "label 1"),
        ("message number 2", "label 0"),
        ("", "label 3"),
        ("x" * 9000, "label 2"),
    ]
    found = by_check(run_checks(labelled(120) + extra, None, CheckLimits()))
    assert (found["duplicates"].status, found["duplicates"].count) == ("warning", 2)
    assert (found["conflicts"].status, found["conflicts"].count) == ("warning", 1)
    assert found["conflicts"].examples == ("message number 2 → label 0, label 2",)
    assert (found["length"].status, found["length"].count) == ("warning", 2)
    assert found["leakage"].status == "skipped"


def test_balance_uses_the_configured_limits() -> None:
    rows = [(f"common {index}", "common") for index in range(190)] + [(f"rare {index}", "rare") for index in range(5)]
    strict = by_check(run_checks(rows, None, CheckLimits()))["balance"]
    assert strict.status == "warning"
    assert "97% of rows" in strict.detail and "fewer than 10 rows" in strict.detail
    loose = by_check(run_checks(rows, None, CheckLimits(majority_share=0.99, min_label_rows=5)))["balance"]
    assert loose.status == "ok"


def test_training_keeps_the_first_of_inputs_that_differ_only_in_surrounding_spaces() -> None:
    rows = [*labelled(120), ("\nmessage number 3", "label 3"), ("message number 4  ", "label 0")]
    found = by_check(run_checks(rows, None, CheckLimits()))["duplicates"]
    assert found.count == 2
    assert len(clean(examples_of(rows))) == 120


def test_balance_names_the_majority_label_as_written() -> None:
    rows = [(f"spam {index}", "Spam") for index in range(95)] + [(f"ham {index}", "Ham") for index in range(5)]
    detail = by_check(run_checks(rows, None, CheckLimits()))["balance"].detail
    assert detail.startswith("'Spam' is 95% of rows")


def test_leakage_finds_test_rows_that_differ_only_in_case_and_punctuation() -> None:
    rows = labelled(300)
    splits = split(clean(examples_of(rows)))
    held_out = splits["golden"][0]
    splits["train"].append(Example(turns=(Turn("user", held_out.input.upper() + "!"),), expected=held_out.expected))
    found = by_check(run_checks(rows, splits, CheckLimits()))["leakage"]
    assert (found.status, found.count) == ("warning", 1)


def test_personal_data_is_found_by_pattern_and_masked() -> None:
    extra: list[tuple[str | None, str | None]] = [
        ("write to jane.doe@example.com please", "label 1"),
        ("card 4111 1111 1111 1111 was charged", "label 2"),
        ("card 4111 1111 1111 1112 is not a real card", "label 2"),
        ("pay into GB82 WEST 1234 5698 7654 32", "label 3"),
        ("call me on +44 20 7946 0958", "label 0"),
        ("order 12345 from 2025-01-15", "label 0"),
    ]
    found = by_check(run_checks(labelled(100) + extra, None, CheckLimits()))["personal_data"]
    assert (found.status, found.count) == ("warning", 4)
    assert "1 email address" in found.detail and "1 card number" in found.detail and "1 IBAN" in found.detail
    assert "jane.doe" not in " ".join(found.examples)
    assert "write to [email address] please" in found.examples


def test_turned_off_checks_report_off_and_hard_stops_still_apply() -> None:
    rows = [(f"row {index}", "only") for index in range(150)]
    found = by_check(run_checks(rows, None, CheckLimits(off=("balance", "personal_data"))))
    assert (found["balance"].status, found["personal_data"].status) == ("off", "off")
    assert found["single_label"].status == "blocked"


def dataset(harness: Harness, sql: str | None = None) -> None:
    source = harness.client.post("/api/sources", files={"file": ("tickets.csv", tickets_csv(), "text/csv")}).json()
    body: dict[str, object] = {"name": "Tickets", "source_id": source["id"]}
    if sql is not None:
        body["sql"] = sql
    assert harness.client.post("/api/datasets", json=body).status_code == 201


def report_of(response: dict) -> dict[str, dict]:
    return {item["check"]: item for item in response["checks"]}


def test_a_version_carries_its_report_and_hard_stops_refuse_it(harness: Harness) -> None:
    dataset(harness)
    report = report_of(harness.client.post("/api/datasets/tickets/versions").json())
    assert report["duplicates"]["status"] == "ok" and report["leakage"]["status"] == "ok"
    single = {"sql": "SELECT text AS input, 'billing' AS label FROM tickets"}
    refused = harness.client.put("/api/datasets/tickets/mapping", json=single)
    assert refused.status_code == 409 and refused.json()["detail"].startswith("Only one label")
    assert harness.client.get("/api/datasets/tickets").json()["mapping"]["sql"] != single["sql"]
    harness.client.put("/api/settings/data", json={"checks_off": ["duplicates", "balance"]})
    assert harness.client.put("/api/datasets/tickets/mapping", json=single).status_code == 409


def test_dismissed_warnings_return_when_their_result_changes(harness: Harness) -> None:
    dataset(
        harness, "SELECT text AS input, category AS label FROM tickets UNION ALL SELECT 'ticket 1 about bug', 'bug'"
    )
    duplicate = report_of(harness.client.post("/api/datasets/tickets/versions").json())["duplicates"]
    assert (duplicate["status"], duplicate["dismissed"]) == ("warning", False)
    dismissed = harness.client.put(
        "/api/datasets/tickets/checks/duplicates/dismissal", json={"signature": duplicate["signature"]}
    )
    assert dismissed.status_code == 204
    latest = report_of(harness.client.get("/api/datasets/tickets").json()["dataset_version"])
    assert latest["duplicates"]["dismissed"] is True
    harness.client.put(
        "/api/datasets/tickets/mapping",
        json={
            "sql": "SELECT text AS input, category AS label FROM tickets "
            "UNION ALL SELECT 'ticket 1 about bug', 'bug' UNION ALL SELECT 'ticket 2 about account', 'account'"
        },
    )
    again = report_of(harness.client.post("/api/datasets/tickets/versions").json())
    assert again["duplicates"]["dismissed"] is False and again["duplicates"]["count"] == 2
    assert harness.client.delete("/api/datasets/tickets/checks/duplicates/dismissal").status_code == 204
    settings = harness.client.put("/api/settings/data", json={"majority_share": 0.6, "min_label_rows": 3}).json()
    assert (settings["majority_share"], settings["min_label_rows"]) == (0.6, 3)
    assert harness.client.put("/api/settings/data", json={"checks_off": ["nonsense"]}).status_code == 422


def test_free_text_answers_skip_the_label_checks() -> None:
    rows: list[tuple[str | None, str | None]] = [(f"question {index}", f"answer {index}") for index in range(120)]
    found = by_check(run_checks(rows, None, CheckLimits(), labelled=False))
    assert "single_label" not in found
    assert found["balance"].status == "skipped"
