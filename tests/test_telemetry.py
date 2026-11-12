import json
import threading
from collections.abc import Iterator
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from opentelemetry.proto.collector.metrics.v1.metrics_service_pb2 import ExportMetricsServiceRequest
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
from opentelemetry.proto.common.v1.common_pb2 import AnyValue, KeyValue
from sqlalchemy import select

from minibrain.connections.vault import unseal
from minibrain.gateway.standalone import create_gateway_app
from minibrain.registry.models import AuditEvent, Setting
from tests.conftest import FakeBackend, Harness
from tests.test_flow import SLUG
from tests.test_gateway import CHAT, servable
from tests.test_policies import policies, set_policy

TRACE = "4bf92f3577b34da6a3ce929d0e0e4736"
PARENT = f"00-{TRACE}-00f067aa0ba902b7-01"
SECRET = "Bearer s3cret-collector-value"


@dataclass
class Received:
    path: str
    headers: dict[str, str]
    body: bytes


@dataclass
class Collector:
    server: ThreadingHTTPServer
    received: list[Received] = field(default_factory=list)
    redirect: str | None = None

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def bodies(self, path: str) -> list[bytes]:
        return [item.body for item in self.received if item.path == path]

    def spans(self) -> list[Any]:
        requests = [ExportTraceServiceRequest.FromString(body) for body in self.bodies("/v1/traces")]
        resources = [resource for request in requests for resource in request.resource_spans]
        scopes = [scope for resource in resources for scope in resource.scope_spans]
        return [span for scope in scopes for span in scope.spans]

    def resources(self) -> list[dict[str, Any]]:
        requests = [ExportTraceServiceRequest.FromString(body) for body in self.bodies("/v1/traces")]
        return [attributes(resource.resource.attributes) for request in requests for resource in request.resource_spans]

    def metrics(self) -> dict[str, Any]:
        found: dict[str, Any] = {}
        for body in self.bodies("/v1/metrics"):
            request = ExportMetricsServiceRequest.FromString(body)
            for resource in request.resource_metrics:
                for scope in resource.scope_metrics:
                    found |= {metric.name: metric for metric in scope.metrics}
        return found


def value_of(found: AnyValue) -> Any:
    kind = found.WhichOneof("value")
    if kind == "array_value":
        return [value_of(item) for item in found.array_value.values]
    return getattr(found, kind) if kind else None


def attributes(items: Any) -> dict[str, Any]:
    pairs: list[KeyValue] = list(items)
    return {pair.key: value_of(pair.value) for pair in pairs}


def receiver() -> Collector:
    collector: Collector

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            body = self.rfile.read(int(self.headers.get("content-length", "0")))
            headers = {key.lower(): value for key, value in self.headers.items()}
            collector.received.append(Received(self.path, headers, body))
            if collector.redirect:
                self.send_response(307)
                self.send_header("Location", collector.redirect + self.path)
            else:
                self.send_response(200)
                self.send_header("Content-Type", "application/x-protobuf")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, format: str, *args: Any) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    collector = Collector(server)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return collector


@pytest.fixture
def collector() -> Iterator[Collector]:
    found = receiver()
    yield found
    found.server.shutdown()
    found.server.server_close()


def export_to(harness: Harness, collector: Collector, headers: str = "") -> None:
    assert set_policy(harness, "otel_endpoint", collector.url) == 200
    if headers:
        assert set_policy(harness, "otel_headers", headers) == 200
    assert set_policy(harness, "otel_protocol", "http/protobuf") == 200
    assert harness.app.state.telemetry.refresh()


def test_export_is_off_by_default_and_sends_nothing(collector: Collector, harness: Harness) -> None:
    headers = servable(harness)
    found = policies(harness)
    assert found["otel_protocol"]["value"] == "off" and found["otel_endpoint"]["value"] == ""
    assert harness.client.post("/v1/chat/completions", headers=headers, json=CHAT).status_code == 200
    assert harness.app.state.telemetry.exporting is None and harness.app.state.telemetry.refresh() is False
    harness.app.state.telemetry.flush()
    assert collector.received == []
    assert harness.client.get("/api/system/install").json()["observability"]["otlp"] is False


def test_a_v1_request_is_one_genai_span_without_prompt_or_answer(collector: Collector, harness: Harness) -> None:
    headers = servable(harness)
    export_to(harness, collector, f"Authorization={SECRET},X-Scope-OrgID=acme")
    assert set_policy(harness, "network", "offline") == 200
    reply = harness.client.post("/v1/chat/completions", headers=headers | {"traceparent": PARENT}, json=CHAT)
    assert reply.status_code == 200
    missing = harness.client.post("/v1/chat/completions", headers=headers, json=CHAT | {"model": "nope"})
    assert missing.status_code == 404
    harness.app.state.telemetry.flush()
    served, failed = sorted(collector.spans(), key=lambda span: span.start_time_unix_nano)
    found = attributes(served.attributes)
    assert served.name == f"chat {SLUG}" and served.kind == served.SPAN_KIND_SERVER
    assert served.trace_id.hex() == TRACE
    assert found["gen_ai.operation.name"] == "chat" and found["gen_ai.provider.name"] == "minibrain"
    assert found["gen_ai.request.model"] == SLUG and found["gen_ai.response.model"] == f"{SLUG}@0"
    assert found["gen_ai.response.id"] == reply.json()["id"]
    assert found["gen_ai.usage.input_tokens"] == reply.json()["usage"]["prompt_tokens"]
    assert found["gen_ai.usage.output_tokens"] == reply.json()["usage"]["completion_tokens"]
    assert found["gen_ai.response.finish_reasons"] == ["stop"]
    assert found["server.address"] == "testserver" and found["http.response.status_code"] == 200
    assert found["minibrain.model.slug"] == SLUG and found["minibrain.model.version"] == 0
    assert isinstance(found["minibrain.api_key.id"], int) and "error.type" not in found
    lost = attributes(failed.attributes)
    assert failed.name == "chat nope" and lost["error.type"] == "model_not_found"
    assert lost["gen_ai.request.model"] == "nope"
    payload = b"".join(item.body for item in collector.received)
    assert b"charged twice" not in payload and b"billing" not in payload
    sent = collector.received[0].headers
    assert sent["authorization"] == SECRET and sent["x-scope-orgid"] == "acme"
    assert collector.resources()[0]["service.name"] == "minibrain"
    assert {item.path for item in collector.received} <= {"/v1/traces", "/v1/metrics"}


def test_metrics_cover_duration_tokens_requests_queue_and_workers(collector: Collector, harness: Harness) -> None:
    headers = servable(harness)
    export_to(harness, collector)
    assert harness.client.post("/v1/chat/completions", headers=headers, json=CHAT).status_code == 200
    assert harness.client.post("/v1/chat/completions", json=CHAT).status_code == 401
    harness.app.state.telemetry.flush()
    found = collector.metrics()
    duration = found["gen_ai.client.operation.duration"]
    assert duration.unit == "s" and duration.histogram.data_points[0].count == 1
    assert attributes(duration.histogram.data_points[0].attributes)["gen_ai.request.model"] == SLUG
    tokens = {
        attributes(point.attributes)["gen_ai.token.type"]: point.sum
        for point in found["gen_ai.client.token.usage"].histogram.data_points
    }
    assert set(tokens) == {"input", "output"} and tokens["input"] > 0
    statuses = {
        attributes(point.attributes)["http.response.status_code"]: point.as_int
        for point in found["minibrain.gateway.requests"].sum.data_points
    }
    assert statuses == {200: 1, 401: 1}
    assert found["minibrain.jobs.queued.oldest_age"].gauge.data_points[0].as_double >= 0
    workers = found["minibrain.workers.online"].gauge.data_points
    assert {attributes(point.attributes)["minibrain.pool"] for point in workers} == {"local"}


def test_collector_headers_are_write_only_and_encrypted(harness: Harness) -> None:
    assert set_policy(harness, "otel_headers", f"Authorization={SECRET}") == 200
    shown = harness.client.get("/api/policies")
    assert policies(harness)["otel_headers"]["value"] == ["Authorization"] and "s3cret" not in shown.text
    with harness.sessions() as session:
        stored = session.get(Setting, "policy.otel_headers")
        assert stored is not None and "s3cret" not in json.dumps(stored.value)
        assert unseal(harness.settings, stored.value["sealed"], "policy.otel_headers") == f"Authorization={SECRET}"
        event = session.scalars(select(AuditEvent).where(AuditEvent.target == "otel_headers")).one()
        assert event.detail["from"] == [] and event.detail["to"] == ["Authorization"]
    assert "s3cret" not in harness.client.get("/api/system/diagnostics").content.decode("latin-1")
    assert set_policy(harness, "otel_headers", "no equals sign") == 403
    assert set_policy(harness, "otel_endpoint", "ftp://collector") == 403
    assert set_policy(harness, "otel_endpoint", "https://user:pass@collector:4318") == 403
    assert set_policy(harness, "otel_protocol", "grpc") == 403
    assert set_policy(harness, "otel_headers", "") == 200
    assert policies(harness)["otel_headers"]["value"] == []


def test_install_lists_the_collector_even_when_offline(collector: Collector, harness: Harness) -> None:
    export_to(harness, collector)
    assert set_policy(harness, "network", "offline") == 200
    info = harness.client.get("/api/system/install").json()
    endpoints = {item["name"]: item for item in info["network"]["endpoints"]}
    assert endpoints["OpenTelemetry traces"]["url"] == f"{collector.url}/v1/traces"
    assert endpoints["OpenTelemetry metrics"] == {
        "name": "OpenTelemetry metrics",
        "url": f"{collector.url}/v1/metrics",
        "allowed": True,
        "by_policy": False,
    }
    assert info["observability"]["otlp"] is True


def test_redirects_from_the_collector_are_not_followed(collector: Collector, harness: Harness) -> None:
    elsewhere = receiver()
    try:
        collector.redirect = elsewhere.url
        headers = servable(harness)
        export_to(harness, collector)
        assert harness.client.post("/v1/chat/completions", headers=headers, json=CHAT).status_code == 200
        harness.app.state.telemetry.flush()
        assert collector.received and elsewhere.received == []
    finally:
        elsewhere.server.shutdown()
        elsewhere.server.server_close()


def test_standard_otel_variables_lock_the_settings(
    collector: Collector, harness: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    headers = servable(harness)
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", collector.url)
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_HEADERS", "X-Tenant=acme%20corp")
    monkeypatch.setenv("OTEL_SERVICE_NAME", "minibrain-eu")
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:9")
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:9")
    found = policies(harness)
    assert found["otel_protocol"]["value"] == "http/protobuf" and found["otel_protocol"]["source"] == "environment"
    assert found["otel_headers"]["value"] == ["X-Tenant"] and found["otel_headers"]["locked"] is True
    assert set_policy(harness, "otel_endpoint", "https://elsewhere:4318") == 409
    assert harness.app.state.telemetry.refresh()
    assert harness.client.post("/v1/chat/completions", headers=headers, json=CHAT).status_code == 200
    harness.app.state.telemetry.flush()
    assert collector.received[0].headers["x-tenant"] == "acme corp"
    assert collector.resources()[0]["service.name"] == "minibrain-eu"
    monkeypatch.setenv("OTEL_SDK_DISABLED", "true")
    assert harness.app.state.telemetry.refresh() and harness.app.state.telemetry.exporting is None
    monkeypatch.delenv("OTEL_SDK_DISABLED")
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_PROTOCOL", "grpc")
    assert policies(harness)["otel_protocol"]["value"] == "off"
    harness.app.state.telemetry.refresh()
    assert harness.app.state.telemetry.exporting is None


def test_the_standalone_gateway_reads_its_own_config(
    collector: Collector, harness: Harness, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    headers = servable(harness)
    (tmp_path / "minibrain.yaml").write_text(
        f"policy:\n  otel_protocol: http/protobuf\n  otel_endpoint: {collector.url}\n  otel_service_name: edge\n"
    )
    monkeypatch.setenv("MINIBRAIN_CONFIG", str(tmp_path / "minibrain.yaml"))
    token = harness.settings.secret("gateway_token")
    app = create_gateway_app(
        "http://main", token, tmp_path / "gateway", http=harness.client, backend=FakeBackend(), background=False
    )
    assert app.state.gateway_config.poll(0)
    with TestClient(app) as gateway:
        reply = gateway.post("/v1/chat/completions", headers=headers, json=CHAT)
        assert reply.status_code == 200 and reply.headers["x-request-id"]
        app.state.telemetry.flush()
    [span] = collector.spans()
    assert span.name == f"chat {SLUG}" and collector.resources()[0]["service.name"] == "edge"
