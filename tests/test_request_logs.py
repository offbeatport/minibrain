from datetime import datetime, timedelta
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select

from minibrain.gateway.logs import LogEntry, database_sink
from minibrain.registry.models import ApiKey, Model, RequestLog, now
from tests.conftest import Harness
from tests.test_access import team_of
from tests.test_feedback import chat, send
from tests.test_flow import SLUG, add_key
from tests.test_gateway import CHAT, servable

RESPONSE = "chatcmpl-" + "ab" * 16


def listed(client: TestClient, path: str = "/api/requests", **params: Any) -> dict[str, Any]:
    response = client.get(path, params=params)
    assert response.status_code == 200, response.text
    return response.json()


def ids_of(page: dict[str, Any]) -> list[int]:
    return [item["id"] for item in page["items"]]


def owners(harness: Harness) -> tuple[int, int]:
    with harness.sessions() as session:
        model = session.scalars(select(Model.id).where(Model.slug == SLUG)).one()
        key = session.scalars(select(ApiKey.id).where(ApiKey.name == "ci")).one()
        return model, key


def seed(harness: Harness, *entries: dict[str, Any]) -> list[int]:
    model, key = owners(harness)
    defaults = {"at": now(), "key_id": key, "model_id": model, "model": SLUG, "version": 0}
    defaults |= {"status": 200, "latency_ms": 100.0, "prompt_tokens": 12, "completion_tokens": 2}
    database_sink(harness.sessions)([LogEntry(**(defaults | entry)) for entry in entries])
    with harness.sessions() as session:
        return list(session.scalars(select(RequestLog.id).order_by(RequestLog.id.desc()).limit(len(entries))))[::-1]


def test_pages_newest_first_and_follows_new_rows(harness: Harness) -> None:
    servable(harness)
    first = seed(harness, *({"latency_ms": float(index)} for index in range(5)))
    page = listed(harness.client, limit=2)
    assert ids_of(page) == first[::-1][:2] and page["total"] == 5 and page["next_cursor"] == str(first[3])
    rest = listed(harness.client, limit=2, cursor=page["next_cursor"])
    assert ids_of(rest) == [first[2], first[1]]
    last = listed(harness.client, limit=2, cursor=rest["next_cursor"])
    assert ids_of(last) == [first[0]] and last["next_cursor"] is None
    arrived = seed(harness, {"status": 503})
    fresh = listed(harness.client, after=str(first[-1]))
    assert ids_of(fresh) == arrived and fresh["next_cursor"] is None and fresh["total"] == 6
    gap = listed(harness.client, after=str(first[0]), limit=2)
    assert ids_of(gap) == [arrived[0], first[-1]] and gap["next_cursor"] is not None
    assert harness.client.get("/api/requests", params={"cursor": "x"}).status_code == 422


def test_filters_narrow_the_list_and_facets_skip_their_own(harness: Harness) -> None:
    servable(harness)
    batch = add_key(harness, name="batch")["id"]
    moment = now()
    a, b, c, d, e = seed(
        harness,
        {"at": moment - timedelta(hours=2), "response_id": RESPONSE},
        {"at": moment - timedelta(minutes=10), "version": 1, "response_id": "chatcmpl-" + "cd" * 16},
        {"at": moment - timedelta(minutes=5), "version": 1, "key_id": batch, "status": 422},
        {"at": moment - timedelta(minutes=1), "model_id": None, "model": "nope", "version": None, "status": 404}
        | {"key_id": batch},
        {"at": moment - timedelta(days=3), "model_id": None, "model": "base-x", "version": None, "status": 503},
    )
    client = harness.client
    assert ids_of(listed(client, model=SLUG)) == [c, b, a]
    assert ids_of(listed(client, model=["nope", "base-x"])) == [e, d]
    assert ids_of(listed(client, version=f"{SLUG}@1")) == [c, b]
    assert ids_of(listed(client, version="nonsense")) == []
    assert ids_of(listed(client, key=str(batch))) == [d, c]
    assert ids_of(listed(client, status="ok")) == [b, a]
    assert ids_of(listed(client, status="client_error")) == [d, c]
    assert ids_of(listed(client, status=["ok", "server_error"])) == [e, b, a]
    assert client.get("/api/requests", params={"status": "teapot"}).status_code == 422
    hour = (moment - timedelta(hours=1)).isoformat()
    assert ids_of(listed(client, since=hour)) == [d, c, b]
    assert ids_of(listed(client, until=hour)) == [e, a]
    assert ids_of(listed(client, q="abab")) == [a]
    assert ids_of(listed(client, q=RESPONSE)) == [a]
    assert ids_of(listed(client, q="zz")) == []
    rows = {row["id"]: row for row in listed(client)["items"]}
    assert (rows[b]["model_key"], rows[b]["version"], rows[b]["custom"]) == (SLUG, 1, True)
    assert (rows[d]["model_key"], rows[d]["custom"], rows[d]["status_class"]) == ("nope", False, "client_error")
    assert (rows[c]["key_name"], rows[e]["status_class"]) == ("batch", "server_error")
    facets = listed(client, "/api/requests/facets", status="client_error")
    assert facets["total"] == 2
    assert facets["statuses"] == {"ok": 2, "client_error": 2, "server_error": 1}
    assert [(item["value"], item["count"]) for item in facets["models"]] == [("nope", 1), (SLUG, 1)]
    assert [(item["value"], item["label"], item["count"]) for item in facets["versions"]] == [
        (f"{SLUG}@1", "Support Triage v1", 1)
    ]
    assert sorted((item["label"], item["count"]) for item in facets["keys"]) == [("batch", 2)]
    scoped = listed(client, "/api/requests/facets", model=SLUG)
    assert [(item["value"], item["count"]) for item in scoped["models"]] == [(SLUG, 3), ("base-x", 1), ("nope", 1)]
    assert [(item["value"], item["count"]) for item in scoped["versions"]] == [(f"{SLUG}@1", 2), (f"{SLUG}@0", 1)]


def test_summary_counts_errors_latency_and_tokens(harness: Harness) -> None:
    servable(harness)
    empty = listed(harness.client, "/api/requests/summary")
    assert (empty["requests"], empty["p50_ms"], empty["error_rate"], empty["last_at"]) == (0, None, None, None)
    assert empty["retention_days"] == 30
    statuses = [200] * 7 + [404, 422, 500]
    seed(harness, *({"latency_ms": float(10 * (n + 1)), "status": status} for n, status in enumerate(statuses)))
    summary = listed(harness.client, "/api/requests/summary")
    assert (summary["requests"], summary["errors"], summary["error_rate"]) == (10, 3, 0.3)
    assert (summary["p50_ms"], summary["p95_ms"]) == (50.0, 100.0)
    assert (summary["prompt_tokens"], summary["completion_tokens"]) == (120, 20)
    assert datetime.fromisoformat(summary["last_at"]) <= now()
    failing = listed(harness.client, "/api/requests/summary", status="client_error")
    assert (failing["requests"], failing["p50_ms"], failing["p95_ms"]) == (2, 80.0, 90.0)


def test_the_gateway_records_finish_reasons(harness: Harness) -> None:
    headers = servable(harness)
    chat(harness, headers)
    harness.backend.stopped = False
    chat(harness, headers)
    missing = harness.client.post("/v1/chat/completions", headers=headers, json=CHAT | {"model": "nope"})
    assert missing.status_code == 404
    harness.flush_logs()
    items = listed(harness.client)["items"]
    assert [(item["status"], item["finish_reason"]) for item in items] == [(404, None), (200, "length"), (200, "stop")]
    assert items[0]["response_id"] is None and items[1]["response_id"].startswith("chatcmpl-")
    entry = {"at": now().isoformat(), "key_id": None, "model_id": None, "model": "remote", "version": None}
    entry |= {"status": 200, "latency_ms": 5.0, "finish_reason": "stop"}
    shipped = harness.client.post("/internal/gateway/logs", json={"entries": [entry]}, headers=harness.gateway_headers)
    assert shipped.status_code == 204
    remote = listed(harness.client, model="remote")["items"]
    assert [(item["finish_reason"], item["key_name"]) for item in remote] == [("stop", None)]


def test_bodies_need_the_builder_role_and_feedback_is_linked(harness: Harness) -> None:
    headers = servable(harness)
    secret = headers["Authorization"].removeprefix("Bearer ")
    assert harness.client.put(f"/api/models/{SLUG}/request-bodies", json={"kept": True}).status_code == 200
    response_id = chat(harness, headers)
    sent = send(harness, headers, response_id=response_id, rating="down", correction="bug", comment="double charge")
    assert sent.status_code == 201, sent.text
    unrated = chat(harness, headers)
    harness.flush_logs()
    rows = {item["response_id"]: item for item in listed(harness.client)["items"]}
    assert (rows[response_id]["feedback_down"], rows[response_id]["feedback_up"]) == (1, 0)
    assert (rows[unrated]["feedback_down"], rows[unrated]["feedback_up"]) == (0, 0)
    request_id = rows[response_id]["id"]
    people = team_of(harness)
    path = f"/api/requests/{request_id}"
    full = people.builder.get(path)
    assert full.status_code == 200 and secret not in full.text
    detail = full.json()
    assert (detail["body"], detail["input"], detail["output"]) == ("kept", "I was charged twice", "billing")
    assert (detail["key_name"], detail["finish_reason"], detail["response_id"]) == ("ci", "stop", response_id)
    assert [(item["rating"], item["status"], item["correction"], item["comment"]) for item in detail["feedback"]] == [
        ("down", "pending", "bug", "double charge")
    ]
    assert people.admin.get(path).json()["input"] == "I was charged twice"
    seen = people.viewer.get(path).json()
    assert (seen["body"], seen["input"], seen["output"], seen["key_name"]) == ("hidden", None, None, "ci")
    assert [(item["rating"], item["correction"], item["comment"]) for item in seen["feedback"]] == [
        ("down", None, None)
    ]
    assert people.viewer.get("/api/requests").status_code == 200
    assert people.viewer.get("/api/requests/summary").status_code == 200
    assert people.nobody.get("/api/requests").status_code == 403
    assert people.viewer.get("/api/requests/999999").status_code == 404


def test_requests_without_kept_bodies_say_so(harness: Harness) -> None:
    headers = servable(harness)
    chat(harness, headers)
    harness.flush_logs()
    request_id = listed(harness.client)["items"][0]["id"]
    detail = listed(harness.client, f"/api/requests/{request_id}")
    assert (detail["body"], detail["input"], detail["output"], detail["feedback"]) == ("off", None, None, [])
