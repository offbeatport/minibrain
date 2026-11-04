import uuid
from collections.abc import Iterator
from datetime import datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import create_engine, text

from minibrain.api.overview import aligned, request_overview, step_for
from minibrain.registry.db import make_sessions, migrate
from minibrain.registry.models import RequestLog, now
from tests.conftest import Harness
from tests.test_flow import SLUG
from tests.test_gateway import servable
from tests.test_leader import POSTGRES, needs_postgres
from tests.test_request_logs import seed


def overview(harness: Harness, **params: Any) -> dict[str, Any]:
    response = harness.client.get("/api/requests/overview", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def base(model: str, minutes: float, **extra: Any) -> dict[str, Any]:
    return {"at": now() - timedelta(minutes=minutes), "minibrain_id": None, "model": model, "version": None} | extra


def seeded(harness: Harness) -> datetime:
    servable(harness)
    moment = now()
    rows = [{"at": moment - timedelta(minutes=index * 5 + 1), "latency_ms": float(index + 1)} for index in range(10)]
    rows += [
        {"at": moment - timedelta(minutes=2), "status": 500, "latency_ms": 900.0, "prompt_tokens": 0},
        base("base-a", 3, latency_ms=20.0),
        base("base-a", 4, latency_ms=30.0),
        base("base-a", 30, latency_ms=40.0, status=404),
        base("base-b", 10, latency_ms=5.0, prompt_tokens=100, completion_tokens=7),
        base("base-c", 20, latency_ms=6.0, prompt_tokens=50, completion_tokens=3),
        base("base-a", 60 * 30, latency_ms=1.0),
    ]
    seed(harness, *rows)
    return moment


def test_buckets_are_sized_to_the_range() -> None:
    assert step_for(timedelta(minutes=15)) == 15
    assert step_for(timedelta(hours=1)) == 60
    assert step_for(timedelta(hours=24)) == 1800
    assert step_for(timedelta(days=7)) == 10800
    assert step_for(timedelta(days=30)) == 43200
    moment = datetime.fromisoformat("2026-11-03T10:17:42+00:00")
    assert aligned(moment, 300).isoformat() == "2026-11-03T10:15:00+00:00"


def test_overview_breaks_down_the_top_models_and_folds_the_rest(harness: Harness) -> None:
    moment = seeded(harness)
    since = (moment - timedelta(hours=1)).isoformat()
    found = overview(harness, since=since, until=moment.isoformat(), top=2)
    assert found["bucket_seconds"] == 60 and 60 <= len(found["buckets"]) <= 61
    assert sum(bucket["seconds"] for bucket in found["buckets"]) >= 3600
    assert [item["key"] for item in found["series"]] == [SLUG, "base-a", "other"]
    assert found["series"][0]["custom"] is True and found["series"][2]["other"] is True
    totals: dict[int, int] = {}
    for point in found["points"]:
        totals[point["series"]] = totals.get(point["series"], 0) + point["requests"]
    assert totals == {0: 11, 1: 3, 2: 2}
    other = [point for point in found["points"] if point["series"] == 2]
    assert sum(point["prompt_tokens"] for point in other) == 150
    failing = next(point for point in found["points"] if point["series"] == 0 and point["errors"])
    assert failing["errors"] == 1 and failing["p95_ms"] == 900.0
    table = {row["key"]: row for row in found["models"]}
    assert list(table) == [SLUG, "base-a", "base-b", "base-c"]
    custom = table[SLUG]
    assert custom["requests"] == 11 and custom["errors"] == 1 and abs(custom["error_rate"] - 1 / 11) < 1e-9
    assert custom["p50_ms"] == 6.0 and custom["p95_ms"] == 900.0 and custom["last_at"] is not None
    assert table["base-a"]["requests"] == 3 and table["base-a"]["p50_ms"] == 30.0
    summary = harness.client.get(
        "/api/requests/summary", params={"model": SLUG, "since": since, "until": moment.isoformat()}
    ).json()
    assert (summary["p50_ms"], summary["p95_ms"]) == (custom["p50_ms"], custom["p95_ms"])


def test_overview_follows_the_model_filter_and_the_whole_log(harness: Harness) -> None:
    moment = seeded(harness)
    only = overview(harness, model="base-a", since=(moment - timedelta(hours=1)).isoformat())
    assert [item["key"] for item in only["series"]] == ["base-a"]
    assert [row["requests"] for row in only["models"]] == [3]
    whole = overview(harness, model="base-a")
    assert whole["bucket_seconds"] == 3600 and whole["models"][0]["requests"] == 4
    assert whole["since"] <= (moment - timedelta(hours=30)).isoformat()
    empty = overview(harness, model="nothing")
    assert empty["series"] == [] and empty["points"] == [] and empty["models"] == []
    assert harness.client.get("/api/requests/overview", params={"top": 0}).status_code == 422


@pytest.fixture
def overview_postgres() -> Iterator[str]:
    assert POSTGRES is not None
    name = f"minibrain_{uuid.uuid4().hex[:8]}"
    admin = create_engine(POSTGRES, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.execute(text(f'create database "{name}"'))
    yield POSTGRES.rsplit("/", 1)[0] + f"/{name}"
    with admin.connect() as connection:
        connection.execute(text(f'drop database "{name}" with (force)'))
    admin.dispose()


@needs_postgres
def test_the_same_queries_run_on_postgres(overview_postgres: str) -> None:
    migrate(overview_postgres)
    moment = now()
    rows = [
        RequestLog(
            at=moment - timedelta(minutes=minute),
            model="base-a" if minute % 4 else "base-b",
            status=500 if minute % 5 == 0 else 200,
            latency_ms=float(minute),
            prompt_tokens=minute,
            completion_tokens=1,
        )
        for minute in range(1, 31)
    ]
    with make_sessions(overview_postgres)() as session:
        session.add_all(rows)
        session.commit()
        found = request_overview(session, model=None, since=moment - timedelta(hours=1), until=moment, top=1)
    assert found.bucket_seconds == 60 and [item.key for item in found.series] == ["base-a", "other"]
    first = found.models[0]
    assert (first.key, first.requests, first.p50_ms, first.p95_ms) == ("base-a", 23, 15.0, 29.0)
    assert sum(point.requests for point in found.points) == 30
    assert sum(point.errors for point in found.points) == 6
