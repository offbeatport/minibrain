from datetime import timedelta
from typing import Any

from sqlalchemy import select

from minibrain.registry.models import AuditEvent, Job, JobKind, JobStatus, Model, User, now
from tests.conftest import ADMIN_EMAIL, Harness, give_data
from tests.test_flow import SLUG, add_key, add_version, build_dataset, create_model, create_with_dataset, deploy, finish
from tests.test_gateway import servable
from tests.test_model_page import page
from tests.test_request_logs import seed
from tests.test_teardown import add_base


def traffic(harness: Harness, name: str = SLUG, span: str = "30d") -> dict[str, Any]:
    response = harness.client.get(f"/api/models/{name}/traffic", params={"range": span})
    assert response.status_code == 200, response.text
    return response.json()


def activity(harness: Harness, name: str = SLUG, **params: Any) -> dict[str, Any]:
    response = harness.client.get(f"/api/models/{name}/activity", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def test_traffic_splits_requests_by_version_and_bucket(harness: Harness) -> None:
    servable(harness)
    other = add_key(harness, name="batch")["id"]
    moment = now()
    seed(
        harness,
        {"at": moment - timedelta(minutes=5), "latency_ms": 10.0},
        {"at": moment - timedelta(minutes=4), "latency_ms": 20.0},
        {"at": moment - timedelta(minutes=3), "latency_ms": 900.0, "status": 500},
        {"at": moment - timedelta(hours=3), "version": 1, "latency_ms": 50.0, "key_id": other},
        {"at": moment - timedelta(hours=2), "version": 1, "status": 429, "key_id": None},
        {"at": moment - timedelta(days=3)},
        {"at": moment - timedelta(days=40)},
        {"at": moment - timedelta(minutes=1), "model_id": None, "model": "tiny", "version": None},
    )
    day = traffic(harness, span="24h")
    assert (day["range"], day["bucket_seconds"], len(day["buckets"])) == ("24h", 3600, 24)
    totals = day["totals"]
    assert (totals["requests"], totals["errors"], totals["p99_ms"]) == (5, 2, 900.0)
    assert totals["device_seconds"] == round((10 + 20 + 900 + 50 + 100) / 1000, 3)
    assert [(item["version"], item["requests"], item["live"]) for item in day["versions"]] == [
        (1, 2, False),
        (0, 3, True),
    ]
    assert sum(item["requests"] for item in day["buckets"]) == 5
    assert sum(item["requests"] for item in day["points"]) == 5
    assert {item["version"] for item in day["points"]} == {0, 1}
    assert [(item["status"], item["label"], item["requests"]) for item in day["errors"]] == [
        (429, "429 Too many requests", 1),
        (500, "500 Server error", 1),
    ]
    callers = {(item["name"], item["key_id"] is None): item["requests"] for item in day["callers"]}
    assert callers == {("ci", False): 3, ("batch", False): 1, (None, True): 1}
    assert day["previous"] is not None and day["previous"]["requests"] == 0
    assert [(item["kind"], item["label"]) for item in day["markers"]] == [("live", "v0 deployed")]
    month = traffic(harness)
    assert (month["bucket_seconds"], len(month["buckets"]), month["totals"]["requests"]) == (86400, 30, 6)
    assert month["previous"]["requests"] == 1
    assert harness.client.get(f"/api/models/{SLUG}/traffic", params={"range": "1y"}).status_code == 422
    assert harness.client.get("/api/models/nothing/traffic").status_code == 404


def test_seven_days_match_the_models_list(harness: Harness) -> None:
    servable(harness)
    moment = now()
    today = moment.replace(hour=0, minute=0, second=0, microsecond=0)
    seed(
        harness,
        {"at": moment - timedelta(seconds=30)},
        {"at": today - timedelta(days=6) + timedelta(minutes=1)},
        {"at": today - timedelta(days=6) - timedelta(minutes=1)},
        {"at": today - timedelta(days=3), "version": 1},
    )
    week = traffic(harness, span="7d")
    rows = harness.client.get("/api/models").json()
    listed = next(row for row in rows if row["key"] == SLUG)["usage"]["total"]
    assert week["totals"]["requests"] == listed == 3
    assert week["bucket_seconds"] == 6 * 3600 and 25 <= len(week["buckets"]) <= 28


def test_base_traffic_counts_its_own_requests(harness: Harness) -> None:
    servable(harness)
    add_base(harness, "tiny")
    seed(
        harness,
        {"model_id": None, "model": "tiny", "version": None, "key_id": None},
        {"model_id": None, "model": "tiny", "version": None, "key_id": None, "status": 503},
    )
    found = traffic(harness, "tiny", "24h")
    assert found["totals"]["requests"] == 2
    assert [(item["version"], item["requests"]) for item in found["versions"]] == [(None, 2)]
    assert found["previous"] is None and found["usual_error_rate"] is None
    assert found["errors"][0]["label"] == "503 Unavailable"


def test_activity_tells_what_happened_to_the_model(harness: Harness) -> None:
    create_with_dataset(harness)
    assert harness.client.patch(f"/api/models/{SLUG}", json={"name": "Ticket Triage"}).status_code == 200
    assert harness.client.patch(f"/api/models/{SLUG}", json={"name": "Ticket Triage"}).status_code == 200
    deploy(harness)
    add_key(harness, name="helpdesk")
    add_version(harness, "lora")
    found = activity(harness)
    texts = [event["text"] for event in found["events"]]
    newest = ["started training v1", "created API key helpdesk", "deployed v0", "renamed it to Ticket Triage"]
    assert texts[:4] == newest
    assert texts[-1] == "created Support Triage"
    for event in found["events"]:
        if event["link"] is not None:
            assert event["link"]["label"] in event["text"]
    live = next(event for event in found["events"] if event["action"] == "version.promote")
    assert (live["tone"], live["link"]["version"]) == ("success", 0)
    key = next(event for event in found["events"] if event["action"] == "key.create")
    assert key["link"]["kind"] == "key" and key["link"]["key"].startswith("mb")
    assert activity(harness, limit=2)["total"] == found["total"] and len(activity(harness, limit=2)["events"]) == 2
    with harness.sessions() as session:
        renames = session.query(AuditEvent).filter(AuditEvent.action == "model.update").all()
        assert len(renames) == 1 and renames[0].detail["to"] == {"name": "Ticket Triage"}
    assert harness.client.get("/api/models/nothing/activity").status_code == 404


def status_of(harness: Harness, name: str = SLUG) -> dict[str, Any]:
    return page(harness, name)["status"]


def test_the_status_line_puts_problems_first(harness: Harness) -> None:
    create_with_dataset(harness)
    first = page(harness)
    assert first["created_by"] and first["created_at"]
    assert (first["status"]["text"], first["status"]["action"]["label"]) == ("Ready to train", "Train v1")
    deploy(harness)
    assert status_of(harness) == {
        "tone": "neutral",
        "text": "Ready to train",
        "action": {
            "kind": "train",
            "label": "Train v1",
            "version": 1,
            "job_id": None,
            "job_kind": None,
            "base": None,
            "everyone": False,
        },
    }
    add_version(harness, "prompt")
    scoring = status_of(harness)
    assert (scoring["tone"], scoring["text"], scoring["action"]["kind"]) == ("info", "Scoring v1 · queued", "open_job")
    assert scoring["action"]["job_kind"] == "eval"
    assert scoring["action"]["everyone"] is True
    finish(harness, "eval", accuracy=1.0)
    better = status_of(harness)
    assert better["text"] == "v1 ready · 100.0%" and better["action"]["label"] == "Deploy v1"
    harness.client.post(f"/api/models/{SLUG}/versions/1/promote")
    body = {"input": "I was charged twice", "output": "billing", "rating": "down", "correction": "account"}
    assert harness.client.post(f"/api/models/{SLUG}/feedback", json=body).status_code == 201
    assert status_of(harness)["text"] == "1 feedback row to review"


def test_a_better_version_is_put_against_live(harness: Harness) -> None:
    servable(harness)
    add_version(harness, "prompt")
    finish(harness, "eval", accuracy=1.0)
    better = status_of(harness)
    assert better["tone"] == "info" and better["text"].startswith("v1 beats live by +")
    assert better["action"]["kind"] == "promote" and better["action"]["version"] == 1


def test_errors_and_failures_come_before_the_rest(harness: Harness) -> None:
    servable(harness)
    moment = now()
    usual = [{"at": moment - timedelta(days=3, minutes=index)} for index in range(30)]
    recent = [{"at": moment - timedelta(minutes=index), "status": 500 if index < 5 else 200} for index in range(25)]
    seed(harness, *usual, *recent)
    warned = status_of(harness)
    assert warned["tone"] == "warning"
    assert warned["text"] == "Errors 20.0% in the last 24 hours (usually none)"
    assert warned["action"]["kind"] == "open_monitoring" and warned["action"]["everyone"] is True


def test_a_failed_version_asks_for_a_retry(harness: Harness) -> None:
    servable(harness)
    add_version(harness, "lora")
    claim = harness.claim(["train"])
    assert claim is not None
    body = {"token": claim["token"], "error": "CUDA out of memory", "retryable": False}
    assert harness.internal(f"/jobs/{claim['job_id']}/fail", body).status_code == 204
    failed = status_of(harness)
    assert (failed["tone"], failed["text"]) == ("destructive", "v1 failed: out of memory")
    assert failed["action"] == {
        "kind": "retry_job",
        "label": "Retry",
        "version": None,
        "job_id": claim["job_id"],
        "job_kind": "train",
        "base": None,
        "everyone": False,
    }


def test_a_base_is_deployed_then_built_on(harness: Harness) -> None:
    add_base(harness, "tiny")
    assert status_of(harness, "tiny")["action"]["kind"] == "deploy"
    assert harness.client.post("/api/models/tiny/deploy", json={"deployed": True}).status_code == 200
    live = status_of(harness, "tiny")
    assert (live["tone"], live["text"], live["action"]["kind"]) == ("success", "Live · 0 replicas", "create_custom")
    assert page(harness, "tiny")["created_at"] is not None


def test_the_status_line_never_offers_the_baseline(harness: Harness) -> None:
    create_model(harness)
    empty = status_of(harness)
    assert (empty["text"], empty["action"]["label"]) == ("No data yet", "Add data")
    give_data(harness, SLUG)
    build_dataset(harness)
    ready = status_of(harness)
    assert (ready["text"], ready["action"]["kind"], ready["action"]["version"]) == ("Ready to train", "train", 1)
    add_version(harness, "lora")
    finish(harness, "train")
    finish(harness, "eval", accuracy=0.0)
    trained = status_of(harness)
    assert (trained["text"], trained["action"]["label"]) == ("v1 ready · 0.0%", "Deploy v1")


def test_activity_of_a_recreated_model_holds_only_its_own_events(harness: Harness) -> None:
    create_with_dataset(harness)
    deploy(harness)
    add_key(harness, name="old-key")
    assert harness.client.delete(f"/api/models/{SLUG}", params={"undeploy": True}).status_code == 202
    harness.settle()
    with harness.sessions() as session:
        old = {event.id for event in session.query(AuditEvent).all()}
    assert create_model(harness)["slug"] == f"{SLUG}-2"
    found = activity(harness, f"{SLUG}-2")
    assert [event["text"] for event in found["events"]] == ["scored v0, prompt only", "created Support Triage"]
    assert found["total"] == 2 and not old & {event["id"] for event in found["events"]}
    assert page(harness, f"{SLUG}-2")["created_by"]


def test_activity_names_people_and_tells_how_training_ended(harness: Harness) -> None:
    create_model(harness)
    with harness.sessions() as session:
        user = session.scalar(select(User).where(User.email == ADMIN_EMAIL))
        assert user is not None
        user.name = "Dana Ilie"
        model = session.scalar(select(Model).where(Model.slug == SLUG))
        assert model is not None
        moment = now()
        session.add(AuditEvent(at=moment, actor="lee.chan@example.com", action="model.avatar", target=SLUG, detail={}))
        session.add(
            AuditEvent(
                at=moment + timedelta(seconds=1),
                actor=ADMIN_EMAIL,
                action="feedback.accept",
                target=f"{SLUG}/feedback/1",
                detail={"name": "x"},
            )
        )
        session.add(
            Job(
                kind=JobKind.TRAIN,
                model_id=model.id,
                status=JobStatus.FAILED,
                version_number=7,
                error="CUDA out of memory",
                finished_at=moment + timedelta(seconds=2),
            )
        )
        session.add(
            Job(
                kind=JobKind.TRAIN,
                model_id=model.id,
                status=JobStatus.SUCCEEDED,
                version_number=0,
                finished_at=moment + timedelta(milliseconds=500),
            )
        )
        session.commit()
    found = activity(harness)
    named = [(event["actor_name"], event["text"]) for event in found["events"]]
    assert named[:4] == [
        (None, "v7 failed: out of memory"),
        ("Dana Ilie", "accepted feedback row #1"),
        ("Dana Ilie", "trained v0"),
        ("lee.chan", "changed the avatar"),
    ]
    assert "scored v0, prompt only" not in [text for _, text in named]
    assert found["events"][0]["tone"] == "failed" and found["events"][0]["link"]["version"] == 7
    assert found["events"][1]["actor"] == ADMIN_EMAIL
    assert named[-1][0] == "Dana Ilie" and found["total"] == len(named)
