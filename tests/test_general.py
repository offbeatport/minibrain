import json
from typing import Any

from minibrain.data.splits import read_split
from minibrain.registry.files import dataset_version_location
from minibrain.registry.models import AuditEvent, Job, JobKind, JudgeScore, Model
from minibrain.tasks.examples import Example
from tests.conftest import Harness, blank_dataset, fake_adapter
from tests.test_flow import TIMING

SLUG = "assistant-1"
JUDGE = "qwen3-0.6b"


def conversation(index: int) -> list[dict[str, str]]:
    return [
        {"role": "system", "content": "You answer for Acme support."},
        {"role": "user", "content": f"Hi, my order {index} is late"},
        {"role": "assistant", "content": f"Sorry about order {index}. Where is it going?"},
        {"role": "user", "content": "France"},
        {"role": "assistant", "content": f"Order {index} reaches France within five working days."},
    ]


def chat_jsonl(rows: int = 120) -> bytes:
    lines = [json.dumps({"messages": conversation(index)}) for index in range(rows)]
    unanswered = [{"role": "user", "content": "Is anyone there?"}]
    return ("\n".join([*lines, json.dumps({"messages": unanswered})]) + "\n").encode()


def pairs_csv(header: str, rows: int = 120) -> bytes:
    lines = [header, *(f"how do I reset device {index},Hold the button for {index} seconds" for index in range(rows))]
    return ("\n".join(lines) + "\n").encode()


def create_assistant(harness: Harness, **extra: Any) -> dict[str, Any]:
    name = harness.client.get("/api/models/name?preset=general").json()["name"]
    response = harness.client.post(
        "/api/models", json={"dataset": blank_dataset(harness.client), "name": name, "preset": "general", **extra}
    )
    assert response.status_code == 201, response.text
    return response.json()


def attach(harness: Harness, slug: str, name: str, data: bytes) -> dict[str, Any]:
    source = harness.client.post("/api/sources", files={"file": (name, data, "application/octet-stream")})
    assert source.status_code == 201, source.text
    dataset = harness.client.post("/api/datasets", json={"name": name, "source_id": source.json()["id"]})
    assert dataset.status_code == 201, dataset.text
    chosen = harness.client.put(f"/api/models/{slug}/dataset", json={"dataset": dataset.json()["slug"]})
    assert chosen.status_code == 200, chosen.text
    return chosen.json()


def versions(harness: Harness, slug: str = SLUG) -> dict[int, dict[str, Any]]:
    return {item["number"]: item for item in harness.client.get(f"/api/models/{slug}/versions").json()}


def held_out(harness: Harness, job_id: int) -> dict[str, list[Example]]:
    with harness.sessions() as session:
        job = session.get(Job, job_id)
        assert job is not None and job.version is not None and job.version.dataset_version is not None
        location = dataset_version_location(session, harness.app.state.store, job.version.dataset_version)
        return {name: read_split(location, name) for name in ("golden", "eval")}


def answer(harness: Harness, rewrite: dict[int, str] | None = None) -> tuple[dict[str, Any], dict[str, list[str]]]:
    claim = harness.claim([JobKind.EVAL])
    assert claim is not None, "no eval job queued"
    splits = held_out(harness, claim["job_id"])
    changed = rewrite or {}
    answers = {
        name: [changed.get(index, row.expected) if name == "eval" else row.expected for index, row in enumerate(rows)]
        for name, rows in splits.items()
    }
    body = {"token": claim["token"], "result": {"metrics": TIMING, "answers": answers}, "outputs": {}}
    assert harness.internal(f"/jobs/{claim['job_id']}/complete", body).status_code == 204
    return claim, answers


def judge(harness: Harness, score: float, reason: str) -> dict[str, Any]:
    claim = harness.claim([JobKind.JUDGE])
    assert claim is not None, "no judge job queued"
    keys = [item["key"] for item in claim["params"]["items"]]
    result = {"scores": dict.fromkeys(keys, score), "reasons": dict.fromkeys(keys, reason)}
    body = {"token": claim["token"], "result": result}
    assert harness.internal(f"/jobs/{claim['job_id']}/complete", body).status_code == 204
    return claim


def test_add_model_defaults_for_a_chat_assistant(harness: Harness) -> None:
    assert harness.client.get("/api/models/name?preset=general").json()["name"] == "Assistant 1"
    created = create_assistant(harness)
    assert (created["name"], created["preset"]) == ("Assistant 1", "general")
    assert created["contract"] == {"kind": "text", "json_schema": None, "labels": None}
    assert created["promotion"] == {"thresholds": [], "beats_live": True}
    assert created["graders_default"] is True
    assert [item["name"] for item in created["graders"]] == ["text_similarity"]
    found = created["judge"]
    assert (found["model"], found["source"], found["used"], found["override"]) == (JUDGE, "base", False, None)
    assert "Concise" in found["default_rubric"]
    assert created["instructions"] == ""
    assert "helpful assistant" in created["default_instructions"]
    assert harness.client.get("/api/models/name?preset=general").json()["name"] == "Assistant 2"
    v0 = versions(harness)[0]
    assert (v0["kind"], v0["status"], v0["view"], v0["main_metric"]) == (
        "prompt",
        "ready",
        "free_text",
        "text_similarity",
    )
    assert "helpful assistant" in v0["instructions"]
    schema = {"kind": "json", "json_schema": {"type": "object", "properties": {"a": {"type": "string"}}}}
    narrowed = harness.client.put(f"/api/models/{SLUG}/contract", json={"contract": schema})
    assert narrowed.status_code == 200, narrowed.text
    assert (narrowed.json()["preset"], narrowed.json()["contract"]["json_schema"]) == ("custom", schema["json_schema"])
    custom = harness.client.post(
        "/api/models", json={"dataset": blank_dataset(harness.client), "name": "Free", "preset": "custom"}
    ).json()
    assert custom["judge"]["default_rubric"] is None
    assert versions(harness, "free")[0]["view"] == "free_text"


def test_v0_answers_a_whole_conversation_in_the_playground_at_once(harness: Harness) -> None:
    create_assistant(harness)
    saved = harness.client.put(f"/api/models/{SLUG}/instructions", json={"instructions": "Answer as Acme support."})
    assert saved.status_code == 200
    v1 = harness.client.post(f"/api/models/{SLUG}/versions", json={"kind": "prompt"})
    assert v1.status_code == 201, v1.text
    assert (v1.json()["number"], v1.json()["status"]) == (1, "ready")
    harness.backend.output = "It arrives on Friday."
    turns = [
        {"role": "user", "content": "Where is my order?"},
        {"role": "assistant", "content": "Which order number?"},
        {"role": "user", "content": "Order 7"},
    ]
    played = "/api/playground/chat/completions"
    reply = harness.client.post(played, json={"model": f"{SLUG}@1", "messages": turns})
    assert reply.status_code == 200, reply.text
    assert reply.json()["choices"][0]["message"]["content"] == "It arrives on Friday."
    sent = harness.backend.requests[-1]
    assert sent.constraint is None
    assert [message["role"] for message in sent.messages] == ["system", "user", "assistant", "user"]
    assert sent.messages[0]["content"] == "Answer as Acme support."
    single = harness.client.post(played, json={"model": f"{SLUG}@0", "messages": [{"role": "user", "content": "Hi"}]})
    assert single.status_code == 200
    assert harness.client.post(played, json={"model": f"{SLUG}@0", "messages": []}).status_code == 400


def test_chat_jsonl_is_a_first_class_upload(harness: Harness) -> None:
    create_assistant(harness)
    detail = attach(harness, SLUG, "support.jsonl", chat_jsonl())
    assert detail["mapping"]["template"] == {"messages": "messages"}
    assert "messages" in {column["name"] for column in detail["source"]["columns"]}
    preview = harness.client.get(f"/api/models/{SLUG}/preview").json()
    assert [message["role"] for message in preview["example"]] == ["user", "assistant", "user", "assistant"]
    assert preview["rows"][0]["label"].endswith("within five working days.")
    built = harness.client.post(f"/api/models/{SLUG}/dataset-versions")
    assert built.status_code == 201, built.text
    stored = built.json()["dataset_version"]
    assert (stored["rows"], sum(stored["counts"].values())) == (121, 120)
    assert stored["labels"] == []
    with harness.sessions() as session:
        model = session.query(Model).filter_by(slug=SLUG).one()
        assert model.dataset is not None
        version = model.dataset.versions[-1]
        location = dataset_version_location(session, harness.app.state.store, version)
        example = read_split(location, "train")[0]
    assert [turn.role for turn in example.turns] == ["user", "assistant", "user"]
    assert example.expected.endswith("within five working days.")


def test_two_column_tables_map_to_one_turn_chats(harness: Harness) -> None:
    for header, slug in (("question,answer", "qa"), ("prompt,completion", "pc"), ("input,output", "io")):
        created = harness.client.post(
            "/api/models", json={"dataset": blank_dataset(harness.client), "name": slug, "preset": "general"}
        )
        assert created.status_code == 201, created.text
        detail = attach(harness, slug, f"{slug}.csv", pairs_csv(header))
        first, second = header.split(",")
        assert detail["mapping"]["template"] == {"user": f"{{{first}}}", "assistant": f"{{{second}}}"}
        preview = harness.client.get(f"/api/models/{slug}/preview").json()
        assert [message["role"] for message in preview["example"]] == ["user", "assistant"]
        assert preview["rows"][0]["label"].startswith("Hold the button")


def test_the_judge_model_is_set_per_install_with_a_per_model_override(harness: Harness) -> None:
    create_assistant(harness)
    assert harness.client.get("/api/settings/judge").json() == {"model": None, "name": None}
    missing = harness.client.put("/api/settings/judge", json={"model": "nope"})
    assert missing.status_code == 409
    chosen = harness.client.put("/api/settings/judge", json={"model": JUDGE})
    assert chosen.status_code == 200 and chosen.json()["model"] == JUDGE
    detail = harness.client.get(f"/api/models/{SLUG}").json()
    assert [item["name"] for item in detail["graders"]] == ["judge", "text_similarity"]
    assert (detail["judge"]["source"], detail["judge"]["used"]) == ("install", True)
    overridden = harness.client.put(f"/api/models/{SLUG}/judge", json={"model": JUDGE}).json()
    assert (overridden["judge"]["source"], overridden["judge"]["override"]) == ("model", JUDGE)
    assert harness.client.put(f"/api/models/{SLUG}/judge", json={"model": "nope"}).status_code == 409
    cleared = harness.client.put(f"/api/models/{SLUG}/judge", json={"model": None}).json()
    assert cleared["judge"]["source"] == "install"
    harness.client.put("/api/settings/judge", json={"model": None})
    plain = harness.client.get(f"/api/models/{SLUG}").json()
    assert [item["name"] for item in plain["graders"]] == ["text_similarity"]
    rubric = "Is it correct and short?"
    edited = harness.client.put(
        f"/api/models/{SLUG}/graders", json={"graders": [{"name": "judge", "rubric": rubric}, {"name": "exact_match"}]}
    )
    assert edited.status_code == 200, edited.text
    found = edited.json()
    assert found["graders_default"] is False
    assert (found["judge"]["used"], found["judge"]["source"], found["judge"]["rubric"]) == (True, "base", rubric)
    reset = harness.client.put(f"/api/models/{SLUG}/graders", json={"graders": []}).json()
    assert reset["graders_default"] is True and [item["name"] for item in reset["graders"]] == ["text_similarity"]
    with harness.sessions() as session:
        actions = {event.action for event in session.query(AuditEvent)}
    assert {"settings.judge", "model.judge", "model.graders"} <= actions


def test_a_chat_assistant_end_to_end(harness: Harness) -> None:
    harness.client.put("/api/settings/judge", json={"model": JUDGE})
    create_assistant(harness)
    harness.client.put(f"/api/models/{SLUG}/instructions", json={"instructions": "Answer as Acme support."})
    attach(harness, SLUG, "support.jsonl", chat_jsonl())
    first = harness.client.post(f"/api/models/{SLUG}/versions", json={"kind": "prompt"})
    assert first.status_code == 201, first.text
    v1 = first.json()
    assert v1["number"] == 1 and v1["shots"] == 3
    assert [item["name"] for item in v1["graders"]] == ["judge", "text_similarity"]
    assert v1["graders"][0]["model"] == JUDGE and "Concise" in v1["graders"][0]["rubric"]
    claim, answers = answer(harness, {0: "No idea."})
    assert claim["params"]["answer_tokens"] == 512
    assert claim["params"]["prompting"]["contract"]["kind"] == "text"
    assert versions(harness)[1]["status"] == "evaluating"
    verdict = judge(harness, 0.75, "Right and short.")
    assert verdict["params"]["instructions"] == "Answer as Acme support."
    assert verdict["params"]["judge"] == JUDGE
    judged = sum(len(rows) for rows in answers.values())
    assert len(verdict["params"]["items"]) == judged
    scored = versions(harness)[1]
    values = {item["metric"]: item["value"] for item in scored["held_out"]["scores"]}
    assert (scored["status"], scored["main_metric"], scored["score"]) == ("ready", "judge", 0.75)
    assert values["text_similarity"] < 1
    assert scored["promotion"]["passed"] is True
    shown = harness.client.get(f"/api/models/{SLUG}/versions/1/answers").json()
    assert (shown["number"], shown["live"], shown["metric"]) == (1, None, "judge")
    row = shown["examples"][0]
    assert [turn["role"] for turn in row["messages"]] == ["user", "assistant", "user"]
    assert (row["version"]["answer"], row["version"]["reason"], row["live"]) == ("No idea.", "Right and short.", None)
    assert row["version"]["scores"]["judge"] == 0.75 and row["version"]["scores"]["text_similarity"] < 1
    assert harness.client.post(f"/api/models/{SLUG}/versions/1/promote").status_code == 200

    harness.client.post(f"/api/models/{SLUG}/versions", json={"kind": "prompt"})
    worse = {1: "Wrong answer.", 2: "Also wrong."}
    _, second = answer(harness, {0: "No idea.", **worse})
    verdict = judge(harness, 0.25, "Gets the facts wrong.")
    assert len(verdict["params"]["items"]) == len(worse)
    with harness.sessions() as session:
        assert session.query(JudgeScore).count() == judged + len(worse)
    v2 = versions(harness)[2]
    assert v2["score"] < 0.75
    assert v2["promotion"]["passed"] is False
    assert "judge" in v2["promotion"]["checks"][0]["detail"]
    assert harness.client.post(f"/api/models/{SLUG}/versions/2/promote").status_code == 409
    compared = harness.client.get(f"/api/models/{SLUG}/versions/2/answers").json()
    assert compared["live"] == 1
    flagged = [row for row in compared["examples"] if row["worse"]]
    assert [row["version"]["answer"] for row in flagged] == list(worse.values())
    assert all(row["live"]["scores"]["judge"] == 0.75 for row in flagged)
    assert flagged[0]["version"]["reason"] == "Gets the facts wrong."
    assert flagged[0]["live"]["reason"] == "Right and short."
    assert compared["examples"][0]["worse"] is False
    assert len(second["eval"]) == len(compared["examples"])
    reverse = harness.client.get(f"/api/models/{SLUG}/versions/1/answers", params={"against": 2}).json()
    assert reverse["live"] == 2
    assert next(row["version"]["answer"] for row in reverse["examples"] if row["worse"] is False) == "No idea."
    assert not any(row["worse"] for row in reverse["examples"])

    harness.client.post(f"/api/models/{SLUG}/versions", json={"kind": "prompt"})
    answer(harness, {0: "No idea."})
    assert harness.claim([JobKind.JUDGE]) is None
    assert versions(harness)[3]["status"] == "ready"

    trained = harness.client.post(f"/api/models/{SLUG}/versions", json={"kind": "lora", "max_rows": 100})
    assert trained.status_code == 201, trained.text
    train = harness.claim([JobKind.TRAIN])
    assert train is not None
    assert train["params"]["prompting"]["instructions"] == "Answer as Acme support."
    assert train["params"]["prompting"]["trained"] is True
    adapter = harness.upload(fake_adapter(), "adapter", "tar", "adapter")
    body = {"token": train["token"], "result": {"summary": {"epochs": 1}}, "outputs": {"adapter": adapter}}
    assert harness.internal(f"/jobs/{train['job_id']}/complete", body).status_code == 204
    answer(harness)
    assert len(judge(harness, 1.0, "Matches the reference.")["params"]["items"]) == 1
    v4 = versions(harness)[4]
    assert (v4["kind"], v4["status"]) == ("lora", "ready")
    assert v4["score"] > 0.75
    assert v4["promotion"]["passed"] is True
    assert harness.client.post(f"/api/models/{SLUG}/versions/4/promote").status_code == 200


def instruction_changes(harness: Harness) -> int:
    with harness.sessions() as session:
        return session.query(AuditEvent).filter(AuditEvent.action == "model.instructions").count()


def test_a_version_saves_new_instructions_and_keeps_its_own_snapshot(harness: Harness) -> None:
    create_assistant(harness)
    made = harness.client.post(
        f"/api/models/{SLUG}/versions", json={"kind": "prompt", "instructions": "  Answer as Acme support.  "}
    )
    assert made.status_code == 201, made.text
    assert made.json()["instructions"] == "Answer as Acme support."
    assert harness.client.get(f"/api/models/{SLUG}").json()["instructions"] == "Answer as Acme support."
    reset = harness.client.post(f"/api/models/{SLUG}/versions", json={"kind": "prompt", "instructions": ""})
    assert reset.status_code == 201, reset.text
    assert "helpful assistant" in reset.json()["instructions"]
    assert harness.client.get(f"/api/models/{SLUG}").json()["instructions"] == ""
    kept = versions(harness)
    assert kept[1]["instructions"] == "Answer as Acme support."
    assert "helpful assistant" in kept[2]["instructions"]
    assert instruction_changes(harness) == 2
    same = harness.client.post(f"/api/models/{SLUG}/versions", json={"kind": "prompt", "instructions": ""})
    assert same.status_code == 201, same.text
    assert instruction_changes(harness) == 2


def test_a_refused_version_does_not_save_its_instructions(harness: Harness) -> None:
    create_assistant(harness)
    refused = harness.client.post(
        f"/api/models/{SLUG}/versions", json={"kind": "lora", "instructions": "Answer as Acme support."}
    )
    assert refused.status_code >= 400
    assert harness.client.get(f"/api/models/{SLUG}").json()["instructions"] == ""
    assert instruction_changes(harness) == 0
