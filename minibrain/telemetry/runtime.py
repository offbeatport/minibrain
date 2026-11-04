import logging
import socket
import threading
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import requests
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader, PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.trace import Span, SpanKind, Tracer
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

from minibrain.telemetry.call import Call
from minibrain.telemetry.instruments import Gauges, Instruments, Outcome
from minibrain.telemetry.prometheus import render
from minibrain.telemetry.target import OtlpTarget
from minibrain.versions import library_version

REFRESH_SECONDS = 5.0
SCOPE = "minibrain"
INSTANCE = f"{socket.gethostname()}-{uuid.uuid4().hex[:8]}"

log = logging.getLogger("minibrain.telemetry")

Resolve = Callable[[], OtlpTarget | None]


def software() -> str:
    return library_version("minibrain") or "unknown"


def direct_session() -> requests.Session:
    session = requests.Session()
    session.trust_env = False
    return session


@dataclass
class Exporting:
    target: OtlpTarget
    tracer_provider: TracerProvider | None
    tracer: Tracer | None
    meter_provider: MeterProvider | None
    instruments: Instruments | None

    @staticmethod
    def create(target: OtlpTarget, gauges: Gauges | None) -> "Exporting":
        resource = Resource.create(
            {"service.name": target.service_name, "service.version": software(), "service.instance.id": INSTANCE}
        )
        options: dict[str, Any] = {"headers": dict(target.headers), "certificate_file": target.ca_bundle or None}
        tracer_provider = tracer = meter_provider = instruments = None
        if target.traces_url:
            spans = OTLPSpanExporter(endpoint=target.traces_url, session=direct_session(), **options)
            tracer_provider = TracerProvider(resource=resource)
            tracer_provider.add_span_processor(BatchSpanProcessor(spans))
            tracer = tracer_provider.get_tracer(SCOPE, software())
        if target.metrics_url:
            metrics = OTLPMetricExporter(endpoint=target.metrics_url, session=direct_session(), **options)
            meter_provider = MeterProvider(resource=resource, metric_readers=[PeriodicExportingMetricReader(metrics)])
            meter = meter_provider.get_meter(SCOPE, software())
            instruments = Instruments(meter)
            if gauges is not None:
                gauges.register(meter)
        return Exporting(target, tracer_provider, tracer, meter_provider, instruments)

    def flush(self) -> None:
        if self.tracer_provider is not None:
            self.tracer_provider.force_flush()
        if self.meter_provider is not None:
            self.meter_provider.force_flush()

    def shutdown(self) -> None:
        if self.tracer_provider is not None:
            self.tracer_provider.shutdown()
        if self.meter_provider is not None:
            self.meter_provider.shutdown()


@dataclass
class Scraped:
    reader: InMemoryMetricReader
    provider: MeterProvider
    instruments: Instruments

    @staticmethod
    def create(gauges: Gauges | None) -> "Scraped":
        reader = InMemoryMetricReader()
        provider = MeterProvider(metric_readers=[reader])
        meter = provider.get_meter(SCOPE, software())
        if gauges is not None:
            gauges.register(meter)
        return Scraped(reader, provider, Instruments(meter))

    def text(self) -> str:
        return render(self.reader.get_metrics_data())


class Telemetry:
    def __init__(self, resolve: Resolve, gauges: Gauges | None = None, scraped: bool = False) -> None:
        self.resolve = resolve
        self.gauges = gauges
        self.lock = threading.Lock()
        self.target: OtlpTarget | None = None
        self.exporting: Exporting | None = None
        self.scraped = Scraped.create(gauges) if scraped else None

    def refresh(self) -> bool:
        target = self.resolve()
        with self.lock:
            if target == self.target:
                return False
            previous, self.target = self.exporting, target
            self.exporting = Exporting.create(target, self.gauges) if target is not None else None
        if previous is not None:
            previous.shutdown()
        if target is None:
            log.info("OpenTelemetry export is off")
        else:
            log.info("OpenTelemetry export to %s", ", ".join(url for _, url in target.urls()))
        return True

    def refresh_forever(self, stop: threading.Event) -> None:
        while not stop.wait(REFRESH_SECONDS):
            try:
                self.refresh()
            except Exception:
                log.exception("OpenTelemetry settings could not be applied")

    def watching(self) -> bool:
        return self.scraped is not None or self.exporting is not None

    def start_span(self, name: str, headers: dict[str, str], attributes: dict[str, Any]) -> Span | None:
        exporting = self.exporting
        if exporting is None or exporting.tracer is None:
            return None
        parent = TraceContextTextMapPropagator().extract(carrier=headers)
        return exporting.tracer.start_span(name, context=parent, kind=SpanKind.SERVER, attributes=attributes)

    def record(self, call: Call, outcome: Outcome) -> None:
        exporting = self.exporting
        for instruments in (
            self.scraped.instruments if self.scraped else None,
            exporting.instruments if exporting else None,
        ):
            if instruments is not None:
                instruments.record(call, outcome)

    def prometheus(self) -> str:
        return self.scraped.text() if self.scraped is not None else ""

    def flush(self) -> None:
        if self.exporting is not None:
            self.exporting.flush()

    def shutdown(self) -> None:
        with self.lock:
            previous, self.exporting, self.target = self.exporting, None, None
        if previous is not None:
            previous.shutdown()
        if self.scraped is not None:
            self.scraped.provider.shutdown()
