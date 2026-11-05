import pytest

from minibrain.presets import PLANNED, preset, presets
from minibrain.tasks.contracts import FREE_TEXT, json_contract, label_set
from minibrain.tasks.promotion import Live, Rule, RuleError, Threshold, decide


def test_thresholds_parse_from_text_and_objects() -> None:
    assert Threshold.parse("label_accuracy >= 0.85") == Threshold("label_accuracy", ">=", 0.85)
    assert Threshold.parse({"metric": "json_valid", "op": "==", "value": 1}) == Threshold("json_valid", "==", 1.0)
    with pytest.raises(RuleError):
        Threshold.parse("label_accuracy is high")
    with pytest.raises(RuleError):
        Threshold("label_accuracy", "!=", 1)
    rule = Rule.from_dict({"thresholds": ["label_accuracy >= 0.85", "json_valid == 1"], "beats_live": False})
    assert Rule.from_dict(rule.as_dict()) == rule
    assert Rule.from_dict(None) == Rule()


def test_a_version_passes_only_when_every_threshold_holds() -> None:
    rule = Rule((Threshold("label_accuracy", ">=", 0.85), Threshold("json_valid", "==", 1)), beats_live=False)
    passed = decide(rule, {"label_accuracy": 0.9, "json_valid": 1.0}, "label_accuracy", None)
    assert passed.passed
    failed = decide(rule, {"label_accuracy": 0.8, "json_valid": 1.0}, "label_accuracy", None)
    assert not failed.passed
    assert failed.reason() == "label_accuracy >= 0.85: label_accuracy is 0.8"
    missing = decide(rule, {"label_accuracy": 0.9}, "label_accuracy", None)
    assert "no json_valid score" in missing.reason()
    assert "not scored yet" in decide(rule, None, "label_accuracy", None).reason()


def test_beating_the_live_version_compares_the_main_metric() -> None:
    rule = Rule()
    live = Live(number=2, metrics={"label_accuracy": 0.8})
    assert decide(rule, {"label_accuracy": 0.81}, "label_accuracy", live).passed
    assert decide(rule, {"label_accuracy": 0.8}, "label_accuracy", live).passed
    worse = decide(rule, {"label_accuracy": 0.7}, "label_accuracy", live)
    assert not worse.passed
    assert "against 0.8 for v2" in worse.reason()
    assert decide(rule, None, "label_accuracy", None).passed
    assert not decide(rule, None, "label_accuracy", live).passed
    assert decide(rule, {"label_accuracy": 0.1}, "label_accuracy", Live(number=0, metrics=None)).passed
    assert decide(Rule(beats_live=False), {"label_accuracy": 0.1}, "label_accuracy", live).passed


def test_presets_are_definition_files() -> None:
    assert list(presets()) == ["classify", "custom"]
    classify = preset("classify")
    labels = label_set(["billing", "bug"])
    assert classify.labels_from_data
    assert classify.instructions(labels) == (
        "Classify the input into exactly one label from this list:\nbilling\nbug\n\nAnswer with the label only."
    )
    assert classify.instructions(labels, trained=True) == "Classify the input. Answer with the label only."
    assert classify.default_graders(labels) == [{"name": "label_accuracy"}]
    assert classify.checks == ("min_labels", "label_balance")
    assert classify.view == "classify"
    custom = preset("custom")
    schema = json_contract({"type": "object", "properties": {"total": {"type": "number"}}})
    assert '"total"' in custom.instructions(schema)
    assert custom.instructions(FREE_TEXT) == "Answer the user's message."
    assert [item["name"] for item in custom.default_graders(schema)] == ["json_valid", "json_field_match"]
    assert [item["name"] for item in custom.default_graders(FREE_TEXT)] == ["exact_match", "text_similarity"]
    assert custom.view is None
    assert {item.key for item in PLANNED} == {"extract", "general", "rewrite", "sql"}
