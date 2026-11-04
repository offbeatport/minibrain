import hmac
import ipaddress
import math
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from opentelemetry.sdk.metrics.export import Gauge, Histogram, MetricsData, Sum

from minibrain.auth.addresses import ip_of
from minibrain.policy import config_section

CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"
SCRAPE_CREDENTIAL_ENV = "MINIBRAIN_METRICS_TOKEN"
ADDRESSES_ENV = "MINIBRAIN_METRICS_ADDRESSES"
SHORTEST_TOKEN = 16
UNITS = {"s": "seconds", "ms": "milliseconds", "By": "bytes", "1": "ratio"}
INVALID = re.compile(r"[^a-zA-Z0-9_:]+")
INVALID_LABEL = re.compile(r"[^a-zA-Z0-9_]+")

Network = ipaddress.IPv4Network | ipaddress.IPv6Network


class MetricsConfigError(Exception):
    pass


@dataclass(frozen=True)
class MetricsAccess:
    token: str | None = None
    networks: tuple[Network, ...] = ()

    @property
    def enabled(self) -> bool:
        return self.token is not None or bool(self.networks)

    def refusal(self, client: str | None, authorization: str | None) -> Response | None:
        if not self.enabled:
            return JSONResponse(status_code=404, content={"detail": "Not Found"})
        if self.networks:
            found = ip_of(client)
            if found is None or not any(found in network for network in self.networks):
                return JSONResponse(status_code=403, content={"detail": "this address may not scrape /metrics"})
        if self.token is not None:
            scheme, _, presented = (authorization or "").partition(" ")
            if scheme.lower() != "bearer" or not hmac.compare_digest(presented.strip().encode(), self.token.encode()):
                return JSONResponse(
                    status_code=401,
                    content={"detail": "a valid scrape token is required"},
                    headers={"WWW-Authenticate": "Bearer"},
                )
        return None


def networks_of(values: Any) -> tuple[Network, ...]:
    items = values.split(",") if isinstance(values, str) else values if isinstance(values, list) else []
    found: list[Network] = []
    for item in items:
        if not str(item).strip():
            continue
        try:
            found.append(ipaddress.ip_network(str(item).strip(), strict=False))
        except ValueError as error:
            raise MetricsConfigError(f"metrics.addresses: {item} is not an address or network") from error
    return tuple(found)


def token_of(section: dict[str, Any]) -> str | None:
    if "token" in section:
        message = "metrics.token is not read from minibrain.yaml: name a file in metrics.token_file, or set"
        raise MetricsConfigError(f"{message} {SCRAPE_CREDENTIAL_ENV}")
    token = os.environ.get(SCRAPE_CREDENTIAL_ENV, "").strip()
    if not token and section.get("token_file"):
        path = Path(str(section["token_file"])).expanduser()
        try:
            token = path.read_text().strip()
        except OSError as error:
            raise MetricsConfigError(f"metrics.token_file {path} cannot be read: {error.strerror}") from error
    if token and len(token) < SHORTEST_TOKEN:
        raise MetricsConfigError(f"the /metrics scrape token needs at least {SHORTEST_TOKEN} characters")
    return token or None


def load_metrics_access() -> MetricsAccess:
    section = config_section("metrics")
    addresses = os.environ.get(ADDRESSES_ENV, "").strip() or section.get("addresses")
    return MetricsAccess(token=token_of(section), networks=networks_of(addresses))


def metric_name(name: str, unit: str, counter: bool) -> str:
    base = INVALID.sub("_", name).strip("_")
    suffix = UNITS.get(unit, "" if unit.startswith("{") else INVALID_LABEL.sub("_", unit).strip("_").lower())
    if suffix and not base.endswith(f"_{suffix}"):
        base = f"{base}_{suffix}"
    return f"{base}_total" if counter else base


def label_value(value: Any) -> str:
    text = str(value).lower() if isinstance(value, bool) else str(value)
    return text.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def labels(attributes: Any, extra: dict[str, str] | None = None) -> str:
    pairs = {INVALID_LABEL.sub("_", str(key)): label_value(value) for key, value in dict(attributes or {}).items()}
    pairs |= extra or {}
    if not pairs:
        return ""
    return "{" + ",".join(f'{key}="{value}"' for key, value in sorted(pairs.items())) + "}"


def number(value: float) -> str:
    if math.isinf(value):
        return "+Inf" if value > 0 else "-Inf"
    return str(int(value)) if float(value).is_integer() else repr(float(value))


def histogram_lines(name: str, point: Any) -> list[str]:
    lines: list[str] = []
    running = 0
    for bound, count in zip([*point.explicit_bounds, math.inf], point.bucket_counts, strict=False):
        running += count
        lines.append(f"{name}_bucket{labels(point.attributes, {'le': number(bound)})} {running}")
    lines.append(f"{name}_sum{labels(point.attributes)} {number(point.sum)}")
    lines.append(f"{name}_count{labels(point.attributes)} {point.count}")
    return lines


def metric_lines(metric: Any) -> list[str]:
    data = metric.data
    counter = isinstance(data, Sum) and data.is_monotonic
    name = metric_name(metric.name, metric.unit or "", counter)
    kind = "histogram" if isinstance(data, Histogram) else "counter" if counter else "gauge"
    if not isinstance(data, Histogram | Sum | Gauge):
        return []
    lines = [f"# HELP {name} {metric.description or metric.name}", f"# TYPE {name} {kind}"]
    if isinstance(data, Histogram):
        return lines + [line for point in data.data_points for line in histogram_lines(name, point)]
    return lines + [f"{name}{labels(point.attributes)} {number(point.value)}" for point in data.data_points]


def render(data: MetricsData | None) -> str:
    lines: list[str] = []
    for resource in data.resource_metrics if data else []:
        for scope in resource.scope_metrics:
            for metric in scope.metrics:
                lines += metric_lines(metric)
    return "\n".join(lines) + "\n" if lines else ""


def metrics_response(request: Request) -> Response:
    access: MetricsAccess = request.app.state.metrics_access
    client = request.client.host if request.client else None
    refused = access.refusal(client, request.headers.get("authorization"))
    if refused is not None:
        return refused
    return PlainTextResponse(request.app.state.telemetry.prometheus(), media_type=CONTENT_TYPE)
