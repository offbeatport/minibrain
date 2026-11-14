from minibrain.registry.models import AuditEvent, JobKind
from tests.conftest import Harness
from tests.test_general import JUDGE, SLUG, answer, attach, chat_jsonl, create_assistant, judge, versions


def scored_assistant(harness: Harness) -> None:
    create_assistant(harness)
    attach(harness, SLUG, "support.jsonl", chat_jsonl())
    assert harness.client.post(f"/api/models/{SLUG}/versions", json={"kind": "prompt"}).status_code == 201
    answer(harness, {0: "No idea."})
    assert versions(harness)[1]["main_metric"] == "text_similarity"


def test_rescore_scores_ready_versions_again_with_the_current_graders(harness: Harness) -> None:
    scored_assistant(harness)
    assert harness.client.post(f"/api/models/{SLUG}/versions/1/promote").status_code == 200
    harness.client.put(f"/api/models/{SLUG}/graders", json={"graders": [{"name": "exact_match"}]})
    assert versions(harness)[1]["main_metric"] == "text_similarity"
    started = harness.client.post(f"/api/models/{SLUG}/rescore")
    assert started.status_code == 200, started.text
    assert started.json()["versions"] == [1] and len(started.json()["jobs"]) == 1
    assert versions(harness)[1]["status"] == "ready"
    assert harness.client.post(f"/api/models/{SLUG}/rescore").json()["jobs"] == started.json()["jobs"]
    claim, _ = answer(harness, {0: "No idea."})
    assert claim["params"]["rescore"][0]["name"] == "exact_match"
    rescored = versions(harness)[1]
    assert (rescored["status"], rescored["main_metric"]) == ("ready", "exact_match")
    assert rescored["score"] is not None and rescored["score"] < 1
    with harness.sessions() as session:
        event = session.query(AuditEvent).filter_by(action="model.rescore").first()
        assert event is not None and event.detail["versions"] == [1]
    activity = harness.client.get(f"/api/models/{SLUG}/activity").json()
    assert "re-scoring 1 version" in str(activity)


def test_a_new_judge_rescores_through_a_judge_job(harness: Harness) -> None:
    scored_assistant(harness)
    harness.client.put(f"/api/models/{SLUG}/judge", json={"model": JUDGE})
    harness.client.put(f"/api/models/{SLUG}/graders", json={"graders": [{"name": "judge", "rubric": "Right?"}]})
    assert harness.client.post(f"/api/models/{SLUG}/rescore").json()["versions"] == [1]
    answer(harness)
    verdict = judge(harness, 0.5, "Half right.")
    assert verdict["params"]["rescore"] is True and verdict["params"]["rubric"] == "Right?"
    found = versions(harness)[1]
    assert (found["status"], found["main_metric"], found["score"]) == ("ready", "judge", 0.5)


def test_a_failed_rescore_keeps_the_version_and_its_scores(harness: Harness) -> None:
    scored_assistant(harness)
    before = versions(harness)[1]["score"]
    harness.client.put(f"/api/models/{SLUG}/graders", json={"graders": [{"name": "exact_match"}]})
    harness.client.post(f"/api/models/{SLUG}/rescore")
    claim = harness.claim([JobKind.EVAL])
    assert claim is not None
    body = {"token": claim["token"], "error": "out of memory", "retryable": False}
    assert harness.internal(f"/jobs/{claim['job_id']}/fail", body).status_code == 204
    kept = versions(harness)[1]
    assert (kept["status"], kept["main_metric"], kept["score"]) == ("ready", "text_similarity", before)


def test_versions_still_training_take_the_new_graders_without_a_job(harness: Harness) -> None:
    scored_assistant(harness)
    trained = harness.client.post(f"/api/models/{SLUG}/versions", json={"kind": "lora", "max_rows": 100})
    assert trained.status_code == 201, trained.text
    harness.client.put(f"/api/models/{SLUG}/graders", json={"graders": [{"name": "exact_match"}]})
    assert harness.client.post(f"/api/models/{SLUG}/rescore").json()["versions"] == [1]
    assert [item["name"] for item in versions(harness)[2]["graders"]] == ["exact_match"]


def test_changing_graders_again_mid_rescore_scores_with_the_latest_ones(harness: Harness) -> None:
    scored_assistant(harness)
    harness.client.put(f"/api/models/{SLUG}/graders", json={"graders": [{"name": "exact_match"}]})
    first = harness.client.post(f"/api/models/{SLUG}/rescore").json()["jobs"]
    harness.client.put(f"/api/models/{SLUG}/graders", json={"graders": [{"name": "text_similarity"}]})
    second = harness.client.post(f"/api/models/{SLUG}/rescore").json()["jobs"]
    assert second != first
    assert harness.client.get(f"/api/jobs/{first[0]}").json()["status"] == "cancelled"
    claim, _ = answer(harness, {0: "No idea."})
    assert claim["job_id"] == second[0]
    assert claim["params"]["rescore"][0]["name"] == "text_similarity"
    assert versions(harness)[1]["main_metric"] == "text_similarity"
