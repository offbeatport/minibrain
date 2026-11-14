import pytest

from minibrain.tasks.contracts import (
    FREE_TEXT,
    Contract,
    ContractError,
    answer_of,
    breaking_changes,
    changes,
    constraint,
    json_contract,
    label_set,
    parse_label,
    suggested_contract,
    with_labels,
)
from minibrain.tasks.examples import Turn, assistant_turns, from_chat, from_pair
from minibrain.tasks.prompting import PromptError, Prompting

INVOICE = {
    "type": "object",
    "properties": {"total": {"type": "number"}, "due": {"type": "string"}},
    "required": ["total"],
}


def test_a_label_set_is_a_json_schema_with_one_enum_field_served_bare() -> None:
    contract = label_set(["billing", "bug", "billing"])
    assert contract.kind == "json"
    assert contract.schema is not None
    assert contract.schema["properties"]["label"]["enum"] == ["billing", "bug"]
    assert contract.labels == ("billing", "bug")
    found = constraint(contract)
    assert found is not None and found.choices == ("billing", "bug")
    assert answer_of(contract, " Billing\n").value == "billing"
    assert not answer_of(contract, "refund").valid
    assert Contract.from_dict(contract.as_dict()) == contract


def test_a_label_set_needs_two_labels() -> None:
    with pytest.raises(ContractError, match="two labels"):
        label_set(["only"])


def test_free_text_has_no_constraint_and_json_checks_the_schema() -> None:
    assert constraint(FREE_TEXT) is None
    assert answer_of(FREE_TEXT, " anything ").value == "anything"
    contract = json_contract(INVOICE)
    found = constraint(contract)
    assert found is not None and found.json_schema == INVOICE
    assert answer_of(contract, '```json\n{"total": 120}\n```').valid
    assert not answer_of(contract, '{"due": "soon"}').valid
    assert not answer_of(contract, "not json").valid
    with pytest.raises(ContractError, match="object"):
        json_contract({"type": "string"})
    with pytest.raises(ContractError, match="Invalid JSON Schema"):
        json_contract({"type": "object", "required": "total"})


def test_adding_labels_and_optional_fields_is_additive() -> None:
    old, new = label_set(["billing", "bug"]), label_set(["billing", "bug", "refund"])
    found = changes(old, new)
    assert [(change.detail, change.breaking) for change in found] == [('adds "refund"', False)]
    wider = json_contract(INVOICE | {"properties": INVOICE["properties"] | {"currency": {"type": "string"}}})
    assert breaking_changes(json_contract(INVOICE), wider) == []
    assert changes(json_contract(INVOICE), wider)[0].detail == "adds an optional field"
    assert with_labels(old, ["refund", "bug"]).labels == ("billing", "bug", "refund")


def test_removing_renaming_and_retyping_are_breaking() -> None:
    assert breaking_changes(label_set(["billing", "bug"]), label_set(["billing", "other"]))[0].detail == 'removes "bug"'
    renamed = json_contract(
        {"type": "object", "properties": {"amount": {"type": "number"}, "due": {"type": "string"}}, "required": []}
    )
    details = {change.path: change.detail for change in breaking_changes(json_contract(INVOICE), renamed)}
    assert details["$.total"].startswith("removes the field")
    retyped = json_contract(INVOICE | {"properties": {"total": {"type": "string"}, "due": {"type": "string"}}})
    assert breaking_changes(json_contract(INVOICE), retyped)[0].detail == "changes type from number to string"
    required = json_contract(INVOICE | {"required": ["total", "due"]})
    assert breaking_changes(json_contract(INVOICE), required)[0].detail == "becomes required"
    assert breaking_changes(FREE_TEXT, json_contract(INVOICE))[0].path == "$"
    assert breaking_changes(label_set(["a", "b"]), json_contract(INVOICE))


def test_descriptions_change_nothing() -> None:
    described = json_contract(INVOICE | {"description": "An invoice"})
    assert changes(json_contract(INVOICE), described) == []


def test_parse_label_returns_canonical_case() -> None:
    labels = ["Billing", "card_arrival"]
    assert parse_label(" billing\n", labels) == "Billing"
    assert parse_label("`card_arrival`.", labels) == "card_arrival"
    assert parse_label("something else", labels) is None


def test_chat_rows_become_examples_with_the_last_answer_expected() -> None:
    chat = [
        {"role": "system", "content": "be brief"},
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "hello"},
        {"role": "user", "content": "refund?"},
        {"role": "assistant", "content": "billing"},
    ]
    example = from_chat(chat)
    assert example is not None
    assert example.turns == (Turn("user", "hi"), Turn("assistant", "hello"), Turn("user", "refund?"))
    assert example.expected == "billing"
    assert example.input == "user: hi\nassistant: hello\nuser: refund?"
    trained = assistant_turns(example)
    assert [completion["content"] for _, completion in trained] == ["hello", "billing"]
    assert [len(prompt) for prompt, _ in trained] == [1, 3]
    assert from_chat(chat[:-1]) is None
    assert from_chat([{"role": "assistant", "content": "x"}]) is None
    assert from_chat("not json") is None
    assert from_pair(" text ", " label ") == from_chat(
        '[{"role":"user","content":"text"},{"role":"assistant","content":"label"}]'
    )
    assert from_pair("", "label") is None


def test_prompt_only_adds_instructions_and_shots_trained_only_instructions() -> None:
    contract = label_set(["billing", "bug"])
    shot = from_pair("charged twice", "billing")
    assert shot is not None
    prompt = Prompting("Pick one:\nbilling\nbug", contract, (shot,))
    conversation = [{"role": "system", "content": "ignored"}, {"role": "user", "content": "it crashes"}]
    assert [message["role"] for message in prompt.messages(conversation)] == ["system", "user", "assistant", "user"]
    trained = Prompting("Classify.", contract, (shot,), trained=True)
    assert trained.messages(conversation) == [
        {"role": "system", "content": "Classify."},
        {"role": "user", "content": "it crashes"},
    ]
    assert Prompting.from_dict(prompt.as_dict()) == prompt
    with pytest.raises(PromptError):
        prompt.messages([{"role": "assistant", "content": "x"}])


def test_suggested_output_prefers_labels_then_json_then_free_text() -> None:
    assert suggested_contract(["billing", "bug"], ["billing"]).contract.labels == ("billing", "bug")
    answers = [
        '{"total": 3, "due": "2026-01-01"}',
        '{"total": 4.5, "lines": [{"sku": "a"}]}',
        '```json\n{"total": 1, "due": null}\n```',
    ]
    line = {"type": "object", "properties": {"sku": {"type": "string"}}, "required": ["sku"]}
    lines = {"type": "array", "items": line}
    assert suggested_contract([], answers).contract.schema == {
        "type": "object",
        "properties": {"total": {"type": "number"}, "due": {"type": ["string", "null"]}, "lines": lines},
        "required": ["total"],
    }
    assert suggested_contract([], ["Thanks, I have refunded it.", '{"a": 1}']).contract == FREE_TEXT
    assert suggested_contract([], []).contract == FREE_TEXT
