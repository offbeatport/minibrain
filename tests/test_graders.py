import pytest

from minibrain.tasks.contracts import FREE_TEXT, json_contract, label_set
from minibrain.tasks.examples import from_pair, single
from minibrain.tasks.graders import (
    ExactMatch,
    GraderError,
    JsonFieldMatch,
    JsonValid,
    Judge,
    LabelAccuracy,
    TextSimilarity,
    answer_hash,
    build,
    check_configs,
    grade,
    main_metric,
    metric_values,
)
from minibrain.tasks.judge import Item, grade_value, judge_of, messages_for, pending_items, reason_of

LABELS = ("x", "y")
SCHEMA = {"type": "object", "properties": {"total": {"type": "number"}, "due": {"type": "string"}}}


def test_label_accuracy_keeps_the_classify_scores() -> None:
    examples = [single("a", "x"), single("b", "y"), single("c", "x")]
    result = grade([LabelAccuracy(LABELS)], label_set(LABELS), examples, ["x", "nonsense", "y"])
    values = metric_values(result)
    assert values["label_accuracy"] == pytest.approx(1 / 3)
    assert values["macro_f1"] == pytest.approx((2 / 3 + 0) / 2)
    assert result["invalid_rate"] == pytest.approx(1 / 3)
    assert result["examples"] == 3
    assert [mistake["input"] for mistake in result["mistakes"]] == ["b", "c"]
    report = result["reports"]["label_accuracy"]
    by_label = {item["label"]: item for item in report["labels"]}
    assert by_label["x"] == {
        "label": "x",
        "support": 2,
        "predicted": 1,
        "correct": 1,
        "precision": 1.0,
        "recall": 0.5,
        "f1": pytest.approx(2 / 3),
    }
    assert by_label["y"]["precision"] == 0.0
    assert report["confusion"] == [
        {"gold": "x", "predicted": "y", "count": 1},
        {"gold": "y", "predicted": None, "count": 1},
    ]
    assert {score["grader"] for score in result["scores"]} == {"label_accuracy"}
    assert {score["version"] for score in result["scores"]} == {1}


def test_label_scores_cover_labels_never_seen() -> None:
    result = grade([LabelAccuracy(("x", "y", "z"))], label_set(("x", "y", "z")), [single("a", "x")], ["x"])
    labels = {item["label"]: item for item in result["reports"]["label_accuracy"]["labels"]}
    assert labels["z"]["support"] == 0
    assert labels["z"]["recall"] is None


def test_exact_match_and_text_similarity() -> None:
    example = single("q", "The parcel left on Monday")
    assert ExactMatch().score(" The parcel left on Monday ", example) == {"exact_match": 1.0}
    assert ExactMatch().score("the parcel left on monday", example) == {"exact_match": 0.0}
    assert TextSimilarity().score("the parcel left on monday", example) == {"text_similarity": 1.0}
    assert TextSimilarity().score("nothing alike", example) == {"text_similarity": 0.0}
    assert 0 < TextSimilarity().score("parcel left Tuesday", example)["text_similarity"] < 1


def test_json_graders_check_validity_and_fields() -> None:
    example = single("invoice", '{"total": 120, "due": "2026-12-01"}')
    assert JsonValid(SCHEMA).score('{"total": 120}', example) == {"json_valid": 1.0}
    assert JsonValid(SCHEMA).score('{"total": "120"}', example) == {"json_valid": 0.0}
    assert JsonValid().score("nope", example) == {"json_valid": 0.0}
    fields = JsonFieldMatch()
    assert fields.score('{"total": 120, "due": "2026-12-02"}', example) == {"json_field_match": 0.5}
    result = grade([fields], json_contract(SCHEMA), [example, example], ['{"total": 120}', "nope"])
    assert metric_values(result) == {"json_field_match": 0.25}
    assert result["reports"]["json_field_match"]["fields"] == [
        {"field": "due", "accuracy": 0.0},
        {"field": "total", "accuracy": 0.5},
    ]
    assert result["invalid_rate"] == 0.5
    assert JsonFieldMatch(("total",)).score('{"total": 120}', example) == {"json_field_match": 1.0}


def test_configs_build_graders_for_the_contract() -> None:
    contract = label_set(LABELS)
    assert isinstance(build({"name": "label_accuracy"}, contract), LabelAccuracy)
    with pytest.raises(GraderError, match="label set"):
        build({"name": "label_accuracy"}, FREE_TEXT)
    with pytest.raises(GraderError, match="no grader"):
        build({"name": "vibes"}, FREE_TEXT)
    with pytest.raises(GraderError, match="rubric"):
        build({"name": "judge", "model": "qwen3-0.6b"}, FREE_TEXT)
    with pytest.raises(GraderError, match="once"):
        check_configs([{"name": "exact_match"}, {"name": "exact_match"}], FREE_TEXT)
    with pytest.raises(GraderError, match="at least one"):
        check_configs([], FREE_TEXT)
    assert main_metric([{"name": "json_valid"}, {"name": "exact_match"}]) == "json_valid"
    assert main_metric([]) is None


def test_the_judge_reads_cached_scores_and_lists_what_is_missing() -> None:
    examples = [single("q1", "yes"), single("q2", "no")]
    answers = ["yes", "maybe"]
    empty = Judge("Is it right?", "qwen3-0.6b", "rev1")
    items = pending_items(empty, [*examples, examples[0]], [*answers, answers[0]])
    assert len(items) == 2
    filled = Judge("Is it right?", "qwen3-0.6b", "rev1", {items[0].key: 1.0})
    assert [item.key for item in pending_items(filled, examples, answers)] == [items[1].key]
    result = grade([filled], FREE_TEXT, examples, answers)
    assert metric_values(result) == {"judge": 1.0}
    assert result["reports"]["judge"] == {"judged": 1, "pending": 1}
    other_rubric = Judge("Is it polite?", "qwen3-0.6b", "rev1")
    assert other_rubric.key(answers[0], examples[0]) != items[0].key
    other_model = Judge("Is it right?", "qwen3-0.6b", "rev2")
    assert other_model.key(answers[0], examples[0]) != items[0].key
    assert answer_hash(examples[0], "yes") != answer_hash(examples[0], "no")
    assert judge_of([ExactMatch(), filled]) is filled
    assert Item.from_dict(items[0].as_dict()) == items[0]
    prompt = messages_for("Is it right?", items[0])
    assert prompt[0]["role"] == "system" and "Is it right?" in prompt[1]["content"]
    assert grade_value("5") == 1.0
    assert grade_value(" 3.") == 0.5
    assert grade_value("none") is None
    pair = from_pair("q", "a")
    assert pair is not None and pair.expected == "a"


def test_the_judge_reads_the_system_prompt_and_gives_a_short_reason() -> None:
    example = single("Where is my order?", "It ships on Friday.")
    plain = Judge("Is it right?", "qwen3-0.6b", "rev1")
    told = Judge("Is it right?", "qwen3-0.6b", "rev1", instructions="Answer as Acme support.")
    assert plain.key("Friday.", example) != told.key("Friday.", example)
    [item] = pending_items(told, [example], ["Friday."])
    prompt = messages_for(told.rubric, item, told.instructions)
    assert "Answer as Acme support." in prompt[1]["content"]
    assert "Answer as Acme support." not in messages_for(told.rubric, item)[1]["content"]
    assert (grade_value("4 - Right, a bit long."), reason_of("4 - Right, a bit long.")) == (0.75, "Right, a bit long.")
    assert reason_of("3/5: misses the date.\nMore.") == "misses the date. More."
    assert reason_of("5") is None
