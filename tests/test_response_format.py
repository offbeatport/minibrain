import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
import torch
from fastapi.testclient import TestClient

from minibrain.base_models import QWEN3_0_6B, base_model
from minibrain.gateway.config import base_route_for
from minibrain.gateway.routes import task_constraint
from minibrain.gateway.standalone import create_gateway_app
from minibrain.ml.completion import Completion
from minibrain.ml.runtime import choice_filter
from minibrain.registry.models import RequestLog
from minibrain.serve.backend import CompletionRequest, OutputFormatError
from minibrain.serve.engine import create_engine_app
from minibrain.serve.engines import EngineBackend
from minibrain.serve.sglang_backend import SglangBackend
from minibrain.serve.structured import (
    JSON_OBJECT,
    Constraint,
    TokenTrie,
    choice_grammar,
    finite_choices,
    schema_problem,
    unfenced,
    violation,
)
from tests.conftest import LABELS, FakeBackend, Harness
from tests.test_flow import SLUG
from tests.test_gateway import CHAT, servable

TICKET = {
    "type": "object",
    "properties": {"label": {"type": "string", "enum": list(LABELS)}},
    "required": ["label"],
    "additionalProperties": False,
}
TICKET_FORMAT = {"type": "json_schema", "json_schema": {"name": "ticket", "schema": TICKET, "strict": True}}


def chat(harness: Harness, headers: dict[str, str], **extra: Any) -> Any:
    return harness.client.post("/v1/chat/completions", headers=headers, json=CHAT | extra)


def logged_statuses(harness: Harness) -> list[int]:
    harness.flush_logs()
    with harness.sessions() as session:
        return [log.status for log in session.query(RequestLog).order_by(RequestLog.id)]


@dataclass
class Refusing(FakeBackend):
    def complete(self, request: CompletionRequest) -> Completion:
        if request.constraint is not None:
            self.requests.append(request)
            raise OutputFormatError("the grammar backend is off")
        return super().complete(request)


def test_schemas_are_checked_before_use() -> None:
    assert schema_problem(TICKET) is None
    assert schema_problem({"$defs": {"tag": {"enum": ["a"]}}, "items": {"$ref": "#/$defs/tag"}}) is None
    assert "schema.type must be a type" in str(schema_problem({"type": "strng"}))
    assert "schema.properties.label.required" in str(schema_problem({"properties": {"label": {"required": "yes"}}}))
    assert "does not point inside" in str(schema_problem({"$ref": "https://example.com/schema.json"}))
    assert "regular expression" in str(schema_problem({"pattern": "("}))
    assert "anyOf[1] must be a schema object" in str(schema_problem({"anyOf": [{}, 3]}))
    assert "non-negative integer" in str(schema_problem({"maxItems": -1}))


def test_answers_are_validated_against_the_schema() -> None:
    assert violation(TICKET, {"label": "bug"}) is None
    assert violation(TICKET, {"label": "nope"}) == '$.label must be one of "billing", "bug", "account", "feature"'
    assert violation(TICKET, {}) == "$.label is required"
    assert violation(TICKET, {"label": "bug", "extra": 1}) == "$.extra is not allowed"
    assert violation(TICKET, ["bug"]) == "$ must be object"
    people = {
        "type": "array",
        "minItems": 1,
        "items": {"$ref": "#/$defs/person"},
        "$defs": {
            "person": {
                "type": "object",
                "properties": {"age": {"type": "integer", "minimum": 0}, "name": {"type": ["string", "null"]}},
                "required": ["age"],
            }
        },
    }
    assert violation(people, [{"age": 3, "name": None}]) is None
    assert violation(people, []) == "$ needs at least 1 items"
    assert violation(people, [{"age": -1}]) == "$[0].age must be at least 0"
    assert violation(people, [{"age": True}]) == "$[0].age must be integer"
    assert violation({"anyOf": [{"type": "string"}, {"type": "null"}]}, 1) == "$ matches none of anyOf"
    assert violation({"const": 1}, True) == "$ must be 1"


def test_finite_schemas_become_choices() -> None:
    assert finite_choices({"enum": ["a", "b", "a"]}) == ('"a"', '"b"')
    assert finite_choices(TICKET) == tuple(json.dumps({"label": label}) for label in LABELS)
    flags = {"type": "object", "properties": {"urgent": {"type": "boolean"}}, "required": ["urgent"]}
    assert finite_choices(flags) == ('{"urgent": false}', '{"urgent": true}')
    assert finite_choices({"type": "string", "enum": ["a", 1]}) == ('"a"',)
    assert finite_choices({"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}) is None
    assert finite_choices({"type": "object", "properties": {"label": {"enum": ["a"]}}}) is None
    assert finite_choices({"enum": list(range(300))}) is None
    assert Constraint(json_schema=TICKET).options() == finite_choices(TICKET)
    assert Constraint(json_schema=JSON_OBJECT).options() == ()


def test_choices_compile_to_a_grammar_and_a_token_trie() -> None:
    assert choice_grammar(["bug", 'say "hi"', "a\\b\n"]) == 'root ::= "bug" | "say \\"hi\\"" | "a\\\\b\\n"'
    trie = TokenTrie([[1, 2, 0], [1, 2, 3, 0], [4, 0]])
    assert sorted(trie.allowed([])) == [1, 4]
    assert sorted(trie.allowed([1, 2])) == [0, 3]
    assert trie.allowed([9]) == []
    allowed = choice_filter(trie, 2, 0)
    assert sorted(allowed(0, torch.tensor([7, 7, 1, 2]))) == [0, 3]
    assert allowed(0, torch.tensor([7, 7, 9])) == [0]
    assert unfenced('```json\n{"a": 1}\n```') == '{"a": 1}'
    assert unfenced('  {"a": 1}\n') == '{"a": 1}'


def test_llama_cpp_builds_grammars_and_reports_ones_it_cannot() -> None:
    pytest.importorskip("llama_cpp")
    from minibrain.serve.llamacpp_backend import grammar

    assert grammar(None) is None
    assert grammar(Constraint(choices=LABELS)) is not None
    assert grammar(Constraint(json_schema=TICKET)) is not None
    with pytest.raises(OutputFormatError, match="grammar"):
        grammar(Constraint(json_schema={"$ref": "#/nowhere"}))


def test_classify_answers_are_held_to_the_labels_by_default(harness: Harness) -> None:
    headers = servable(harness)
    reply = chat(harness, headers)
    assert reply.json()["choices"][0]["message"]["content"] == "billing"
    assert chat(harness, headers, response_format={"type": "text"}).status_code == 200
    constraints = [request.constraint for request in harness.backend.requests]
    assert constraints == [Constraint(choices=("account", "billing", "bug", "feature"))] * 2
    played = harness.client.post(f"/api/minibrains/{SLUG}/complete", json={"text": "charged twice"}).json()
    assert played["label"] == "billing"
    assert harness.backend.requests[-1].constraint == constraints[0]
    assert task_constraint(base_route_for("qwen3-0.6b")) is None


def test_json_schema_is_passed_on_and_the_answer_checked(harness: Harness) -> None:
    headers = servable(harness)
    harness.backend.output = '```json\n{"label": "bug"}\n```'
    reply = chat(harness, headers, response_format=TICKET_FORMAT)
    assert reply.status_code == 200, reply.text
    assert reply.json()["choices"][0]["message"]["content"] == '{"label": "bug"}'
    assert harness.backend.requests[-1].constraint == Constraint(json_schema=TICKET)
    streamed = chat(harness, headers, response_format=TICKET_FORMAT, stream=True)
    first = json.loads(streamed.text.split("\n\n")[0].removeprefix("data: "))
    assert first["choices"][0]["delta"]["content"] == '{"label": "bug"}'
    harness.backend.output = '{"open": true}'
    assert chat(harness, headers, response_format={"type": "json_object"}).status_code == 200
    assert harness.backend.requests[-1].constraint == Constraint(json_schema=JSON_OBJECT)


def test_answers_that_break_the_schema_are_422s(harness: Harness) -> None:
    headers = servable(harness)
    harness.backend.output = "billing"
    broken = chat(harness, headers, response_format={"type": "json_object"})
    assert broken.status_code == 422
    assert broken.json()["error"]["code"] == "invalid_json"
    harness.backend.output = '{"label": "refund"}'
    mismatch = chat(harness, headers, response_format=TICKET_FORMAT)
    assert (mismatch.status_code, mismatch.json()["error"]["code"]) == (422, "schema_mismatch")
    assert "$.label must be one of" in mismatch.json()["error"]["message"]
    harness.backend.stopped = False
    cut = chat(harness, headers, response_format=TICKET_FORMAT)
    assert cut.status_code == 200 and cut.json()["choices"][0]["finish_reason"] == "length"
    assert logged_statuses(harness) == [422, 422, 200]
    with harness.sessions() as session:
        assert [log.response_id is None for log in session.query(RequestLog).order_by(RequestLog.id)] == [
            True,
            True,
            False,
        ]


@pytest.mark.parametrize(
    ("response_format", "param", "code"),
    [
        ("json", "response_format", "invalid_value"),
        ({"type": "yaml"}, "response_format.type", "invalid_value"),
        ({"type": "json_schema"}, "response_format.json_schema", "missing_required_parameter"),
        (
            {"type": "json_schema", "json_schema": {"name": "a b", "schema": {}}},
            "response_format.json_schema.name",
            "invalid_value",
        ),
        (
            {"type": "json_schema", "json_schema": {"name": "t"}},
            "response_format.json_schema.schema",
            "missing_required_parameter",
        ),
        (
            {"type": "json_schema", "json_schema": {"name": "t", "schema": {}, "strict": "yes"}},
            "response_format.json_schema.strict",
            "invalid_value",
        ),
        (
            {"type": "json_schema", "json_schema": {"name": "t", "schema": {"type": "strng"}}},
            "response_format.json_schema.schema",
            "invalid_value",
        ),
    ],
)
def test_malformed_response_formats_are_openai_400s(
    harness: Harness, response_format: Any, param: str, code: str
) -> None:
    headers = servable(harness)
    reply = chat(harness, headers, response_format=response_format)
    assert reply.status_code == 400
    error = reply.json()["error"]
    assert (error["type"], error["param"], error["code"]) == ("invalid_request_error", param, code)
    assert harness.backend.requests == []
    assert logged_statuses(harness) == [400]


def test_an_engine_that_refuses_a_grammar(harness: Harness) -> None:
    headers = servable(harness)
    refusing = Refusing()
    harness.app.state.backend = refusing
    assert chat(harness, headers).json()["choices"][0]["message"]["content"] == "billing"
    assert [request.constraint is None for request in refusing.requests] == [False, True]
    reply = chat(harness, headers, response_format=TICKET_FORMAT)
    assert reply.status_code == 400 and "grammar backend is off" in reply.json()["error"]["message"]


def test_engines_carry_the_constraint_and_its_refusal(harness: Harness, tmp_path: Path) -> None:
    fake = FakeBackend(output='{"label": "bug"}')
    app = create_engine_app(
        base_model("qwen3-0.6b"), "http://main", "t", tmp_path / "engine", backend=fake, http=harness.client
    )
    messages = [{"role": "user", "content": "x"}]
    with TestClient(app) as engine:
        backend = EngineBackend(lambda: {"qwen3-0.6b": [{"url": "http://testserver", "state": "ready"}]}, http=engine)
        constrained = CompletionRequest(base_model("qwen3-0.6b"), messages, None, 8, Constraint(json_schema=TICKET))
        assert backend.complete(constrained).text == '{"label": "bug"}'
        assert fake.requests[-1].constraint == Constraint(json_schema=TICKET)
        labels = CompletionRequest(base_model("qwen3-0.6b"), messages, None, 8, Constraint(choices=LABELS))
        backend.complete(labels)
        assert fake.requests[-1].constraint == Constraint(choices=LABELS)
    refusing = create_engine_app(
        base_model("qwen3-0.6b"), "http://main", "t", tmp_path / "engine2", backend=Refusing(), http=harness.client
    )
    with TestClient(refusing) as engine:
        backend = EngineBackend(lambda: {"qwen3-0.6b": [{"url": "http://testserver", "state": "ready"}]}, http=engine)
        with pytest.raises(OutputFormatError, match="grammar backend is off"):
            backend.complete(constrained)


def test_standalone_gateway_returns_openai_errors(harness: Harness, tmp_path: Path) -> None:
    headers = servable(harness)
    token = harness.settings.secret("gateway_token")
    home = tmp_path / "gw"
    app = create_gateway_app("http://main", token, home, http=harness.client, backend=FakeBackend(), background=False)
    assert app.state.gateway_config.poll(0)
    with TestClient(app) as gateway:
        reply = gateway.post("/v1/chat/completions", headers=headers, json=CHAT | {"response_format": {"type": "x"}})
        assert reply.status_code == 400 and reply.json()["error"]["param"] == "response_format.type"
        broken = gateway.post("/v1/chat/completions", headers=headers, json=CHAT | {"response_format": TICKET_FORMAT})
        assert broken.status_code == 422 and broken.json()["error"]["code"] == "invalid_json"


def test_sglang_receives_ebnf_for_labels_and_json_schema_for_schemas(tmp_path: Path) -> None:
    log = tmp_path / "requests.jsonl"
    script = Path(__file__).parent / "fake_sglang.py"
    backend = SglangBackend(
        lambda _artifact: tmp_path,
        command=lambda _spec, port: [sys.executable, str(script), "--port", str(port), "--log", str(log)],
        startup_seconds=30,
    )
    messages = [{"role": "user", "content": "hello"}]
    refused = {"type": "object", "x-refuse": True}
    try:
        backend.complete(CompletionRequest(QWEN3_0_6B, messages, None, 8, Constraint(choices=("bug", "billing"))))
        backend.complete(CompletionRequest(QWEN3_0_6B, messages, None, 8, Constraint(json_schema=TICKET)))
        with pytest.raises(OutputFormatError, match="grammar compilation failed"):
            backend.complete(CompletionRequest(QWEN3_0_6B, messages, None, 8, Constraint(json_schema=refused)))
    finally:
        backend.close()
    chat_bodies = [json.loads(line)["body"] for line in log.read_text().splitlines()]
    assert chat_bodies[0]["ebnf"] == 'root ::= "bug" | "billing"' and "response_format" not in chat_bodies[0]
    assert chat_bodies[1]["response_format"] == {
        "type": "json_schema",
        "json_schema": {"name": "response", "schema": TICKET, "strict": True},
    }
    assert "ebnf" not in chat_bodies[1]
