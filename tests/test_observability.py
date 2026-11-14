import io
import json
import logging
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from minibrain.recent_logs import capture
from minibrain.telemetry.call import CURRENT, Call
from minibrain.telemetry.context import RequestContext
from minibrain.telemetry.logs import UVICORN_LOGGERS, JsonFormatter, LogFormatError, configure_logging, log_format
from minibrain.telemetry.prometheus import (
    MetricsAccess,
    MetricsConfigError,
    label_value,
    load_metrics_access,
    metric_name,
    networks_of,
)
from minibrain.telemetry.setup import main_telemetry
from tests.conftest import Harness
from tests.test_flow import SLUG
from tests.test_gateway import CHAT, servable

TOKEN = "scrape-" + "x" * 32


def scraped(harness: Harness, access: MetricsAccess) -> None:
    harness.app.state.metrics_access = access
    harness.app.state.telemetry = main_telemetry(harness.sessions, harness.settings, access)


def test_metrics_is_off_by_default(harness: Harness) -> None:
    assert harness.app.state.metrics_access.enabled is False
    anonymous = TestClient(harness.app)
    assert anonymous.get("/metrics").status_code == 404
    assert harness.client.get("/api/system/install").json()["observability"]["metrics"] is False


def test_a_scrape_needs_the_token_and_no_session(harness: Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MINIBRAIN_METRICS_TOKEN", TOKEN)
    scraped(harness, load_metrics_access())
    headers = servable(harness)
    assert harness.client.post("/v1/chat/completions", headers=headers, json=CHAT).status_code == 200
    assert harness.client.post("/v1/chat/completions", json=CHAT).status_code == 401
    anonymous = TestClient(harness.app)
    refused = anonymous.get("/metrics")
    assert refused.status_code == 401 and refused.headers["www-authenticate"] == "Bearer"
    assert anonymous.get("/metrics", headers={"Authorization": "Bearer wrong"}).status_code == 401
    reply = anonymous.get("/metrics", headers={"Authorization": f"Bearer {TOKEN}"})
    assert reply.status_code == 200 and reply.headers["content-type"].startswith("text/plain; version=0.0.4")
    text = reply.text
    assert "# TYPE gen_ai_client_operation_duration_seconds histogram" in text
    assert "# TYPE gen_ai_client_token_usage histogram" in text
    assert "# TYPE minibrain_gateway_requests_total counter" in text
    route = 'http_route="/v1/chat/completions"'
    assert f'requests_total{{gen_ai_request_model="{SLUG}",http_response_status_code="200",{route}}} 1' in text
    assert f'gen_ai_request_model="_unknown",http_response_status_code="401",{route}}} 1' in text
    assert 'gen_ai_token_type="output",le="+Inf"} 1' in text
    assert "minibrain_jobs_queued_oldest_age_seconds 0" in text
    assert 'minibrain_workers_online{minibrain_pool="local"} 1' in text
    assert "charged twice" not in text
    install = harness.client.get("/api/system/install").json()["observability"]
    assert install["metrics"] is True and install["metrics_token"] is True


def test_a_scrape_can_be_limited_to_addresses(harness: Harness) -> None:
    scraped(harness, MetricsAccess(networks=networks_of(["10.0.0.0/8", "fd00::/8"])))
    assert TestClient(harness.app, client=("10.1.2.3", 9100)).get("/metrics").status_code == 200
    assert TestClient(harness.app, client=("fd00::5", 9100)).get("/metrics").status_code == 200
    assert TestClient(harness.app, client=("192.168.1.9", 9100)).get("/metrics").status_code == 403
    assert TestClient(harness.app).get("/metrics").status_code == 403
    both = MetricsAccess(token=TOKEN, networks=networks_of("10.0.0.0/8"))
    scraped(harness, both)
    near = TestClient(harness.app, client=("10.1.2.3", 9100))
    assert near.get("/metrics").status_code == 401
    assert near.get("/metrics", headers={"Authorization": f"Bearer {TOKEN}"}).status_code == 200


def test_scrape_settings_come_from_the_config_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    config = tmp_path / "minibrain.yaml"
    secret = tmp_path / "metrics-token"
    secret.write_text(TOKEN + "\n")
    monkeypatch.setenv("MINIBRAIN_CONFIG", str(config))
    config.write_text(f"metrics:\n  addresses: [10.0.0.10/32]\n  token_file: {secret}\n")
    access = load_metrics_access()
    assert access.token == TOKEN and [str(item) for item in access.networks] == ["10.0.0.10/32"]
    monkeypatch.setenv("MINIBRAIN_METRICS_ADDRESSES", "127.0.0.1, 10.1.0.0/16")
    assert [str(item) for item in load_metrics_access().networks] == ["127.0.0.1/32", "10.1.0.0/16"]
    config.write_text("metrics:\n  token: plain-text-in-the-file\n")
    with pytest.raises(MetricsConfigError, match="token_file"):
        load_metrics_access()
    config.write_text("metrics:\n  addresses: [nowhere]\n")
    monkeypatch.delenv("MINIBRAIN_METRICS_ADDRESSES")
    with pytest.raises(MetricsConfigError, match="nowhere"):
        load_metrics_access()
    monkeypatch.setenv("MINIBRAIN_METRICS_TOKEN", "short")
    config.write_text("")
    with pytest.raises(MetricsConfigError, match="16 characters"):
        load_metrics_access()


def test_prometheus_names_follow_the_otel_conventions() -> None:
    assert metric_name("gen_ai.client.operation.duration", "s", False) == "gen_ai_client_operation_duration_seconds"
    assert metric_name("gen_ai.client.token.usage", "{token}", False) == "gen_ai_client_token_usage"
    assert metric_name("minibrain.gateway.requests", "{request}", True) == "minibrain_gateway_requests_total"
    assert metric_name("minibrain.jobs.queued.oldest_age", "s", False) == "minibrain_jobs_queued_oldest_age_seconds"
    assert label_value('a "quoted"\\path\nnext') == 'a \\"quoted\\"\\\\path\\nnext'


@pytest.fixture
def restored_logging() -> Iterator[None]:
    names = ["", *UVICORN_LOGGERS]
    saved = {name: (logging.getLogger(name).handlers[:], logging.getLogger(name).propagate) for name in names}
    level = logging.getLogger().level
    yield
    for name, (handlers, propagate) in saved.items():
        logging.getLogger(name).handlers = handlers
        logging.getLogger(name).propagate = propagate
    logging.getLogger().setLevel(level)


def test_log_format_is_text_unless_asked(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MINIBRAIN_CONFIG", str(tmp_path / "minibrain.yaml"))
    assert log_format() == "text"
    (tmp_path / "minibrain.yaml").write_text("logging:\n  format: json\n")
    assert log_format() == "json"
    monkeypatch.setenv("MINIBRAIN_LOG_FORMAT", "text")
    assert log_format() == "text"
    monkeypatch.setenv("MINIBRAIN_LOG_FORMAT", "xml")
    with pytest.raises(LogFormatError):
        log_format()


def test_json_lines_carry_the_request_and_response_ids(restored_logging: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MINIBRAIN_LOG_FORMAT", "json")
    root_before = logging.getLogger().handlers[:]
    configure_logging()
    assert logging.getLogger().handlers != root_before
    assert all(isinstance(handler.formatter, JsonFormatter) for handler in logging.getLogger("uvicorn").handlers)
    formatter = JsonFormatter()
    token = CURRENT.set(Call(request_id="req-1", response_id="chatcmpl-" + "ab" * 16))
    try:
        record = logging.LogRecord("minibrain.gateway", logging.WARNING, __file__, 1, "slow %s", ("engine",), None)
        line = json.loads(formatter.format(record))
        args = ("10.0.0.5:5000", "POST", "/v1/chat/completions", "1.1", 200)
        access = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1, '%s - "%s %s HTTP/%s" %d', args, None)
        entry = json.loads(formatter.format(access))
    finally:
        CURRENT.reset(token)
    assert line["level"] == "warning" and line["logger"] == "minibrain.gateway" and line["message"] == "slow engine"
    assert line["request_id"] == "req-1" and line["response_id"].startswith("chatcmpl-")
    assert line["time"].endswith("Z")
    assert entry["method"] == "POST" and entry["status"] == 200 and entry["path"] == "/v1/chat/completions"
    plain = json.loads(formatter.format(record))
    assert "request_id" not in plain


def test_text_logs_stay_untouched(restored_logging: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MINIBRAIN_LOG_FORMAT", raising=False)
    before = logging.getLogger("uvicorn").handlers[:]
    configure_logging()
    assert logging.getLogger("uvicorn").handlers == before


def test_every_response_carries_a_request_id(harness: Harness) -> None:
    generated = harness.client.get("/healthz").headers["x-request-id"]
    assert len(generated) == 32 and int(generated, 16) >= 0
    assert harness.client.get("/healthz", headers={"X-Request-ID": "edge-42"}).headers["x-request-id"] == "edge-42"
    assert harness.client.get("/healthz", headers={"X-Request-ID": "bad id!"}).headers["x-request-id"] != "bad id!"


def test_logs_inside_a_request_know_its_id() -> None:
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter())
    logger = logging.getLogger("minibrain.test.request")
    logger.addHandler(handler)
    app = FastAPI()

    @app.get("/work")
    def work() -> dict[str, str]:
        logger.warning("working")
        return {"ok": "yes"}

    app.add_middleware(RequestContext)
    try:
        reply = TestClient(app).get("/work", headers={"X-Request-ID": "trace-me"})
    finally:
        logger.removeHandler(handler)
    assert reply.headers["x-request-id"] == "trace-me"
    assert json.loads(stream.getvalue())["request_id"] == "trace-me"


def test_a_crash_answers_500_with_its_request_id() -> None:
    app = FastAPI()

    @app.get("/crash")
    def crash() -> None:
        raise RuntimeError("boom")

    app.add_middleware(RequestContext)
    reply = TestClient(app, raise_server_exceptions=False).get("/crash", headers={"X-Request-ID": "crash-1"})
    assert reply.status_code == 500 and reply.headers["x-request-id"] == "crash-1"
    with pytest.raises(RuntimeError):
        TestClient(app).get("/crash")


def test_text_logs_still_reach_the_console_once_captured(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    capture()
    monkeypatch.setattr(logging.getLogger(), "handlers", [])
    logging.getLogger("minibrain").error("audit chain seal failed")
    logging.getLogger("minibrain").info("quiet")
    assert capsys.readouterr().err == "ERROR: audit chain seal failed\n"
    monkeypatch.setattr(logging.getLogger(), "handlers", [logging.NullHandler()])
    logging.getLogger("minibrain").error("handled by root")
    assert capsys.readouterr().err == ""
