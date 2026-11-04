import logging
import os
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from minibrain.connections.vault import VaultError
from minibrain.policy import BY_NAME, OTLP_HTTP, PolicyError, header_pairs, locked_sources

TRACES_PATH = "/v1/traces"
METRICS_PATH = "/v1/metrics"
TRACES_ENV = "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"
METRICS_ENV = "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"

log = logging.getLogger("minibrain.telemetry")

Unseal = Callable[[str, str], str]


class TargetError(Exception):
    pass


@dataclass(frozen=True)
class OtlpTarget:
    traces_url: str | None
    metrics_url: str | None
    headers: tuple[tuple[str, str], ...]
    service_name: str
    ca_bundle: str

    def urls(self) -> list[tuple[str, str]]:
        found = [("OpenTelemetry traces", self.traces_url), ("OpenTelemetry metrics", self.metrics_url)]
        return [(name, url) for name, url in found if url]


def signal_url(base: str, path: str, variable: str, signal: str) -> str | None:
    if os.environ.get(f"OTEL_{signal.upper()}_EXPORTER", "").strip().lower() == "none":
        return None
    explicit = os.environ.get(variable, "").strip()
    if explicit:
        return explicit
    return f"{base}{path}" if base else None


def header_text(value: Any, unseal: Unseal | None) -> str:
    if not isinstance(value, dict):
        return ""
    if value.get("plain"):
        return str(value["plain"])
    if value.get("sealed") and unseal is not None:
        return unseal(str(value["sealed"]), "policy.otel_headers")
    return ""


def target_of(values: dict[str, Any], unseal: Unseal | None = None) -> OtlpTarget | None:
    if values.get("otel_protocol") != OTLP_HTTP:
        return None
    base = str(values.get("otel_endpoint") or "")
    traces = signal_url(base, TRACES_PATH, TRACES_ENV, "traces")
    metrics = signal_url(base, METRICS_PATH, METRICS_ENV, "metrics")
    if traces is None and metrics is None:
        return None
    try:
        headers = tuple(header_pairs(header_text(values.get("otel_headers"), unseal)))
    except (PolicyError, VaultError) as error:
        raise TargetError(f"the collector headers cannot be read: {error}") from error
    return OtlpTarget(
        traces_url=traces,
        metrics_url=metrics,
        headers=headers,
        service_name=str(values.get("otel_service_name") or "minibrain"),
        ca_bundle=str(values.get("otel_ca_bundle") or ""),
    )


def configured_values() -> dict[str, Any]:
    names = ("otel_protocol", "otel_endpoint", "otel_headers", "otel_service_name", "otel_ca_bundle")
    values = {name: BY_NAME[name].default for name in names}
    try:
        locked = locked_sources()
    except PolicyError as error:
        raise TargetError(str(error)) from error
    return values | {name: value for name, (_, value) in locked.items() if name in values}


def warn_once(resolve: Callable[[], OtlpTarget | None]) -> Callable[[], OtlpTarget | None]:
    last = [""]

    def resolved() -> OtlpTarget | None:
        try:
            found = resolve()
        except TargetError as error:
            if str(error) != last[0]:
                log.warning("OpenTelemetry export is paused: %s", error)
            last[0] = str(error)
            return None
        last[0] = ""
        return found

    return resolved
