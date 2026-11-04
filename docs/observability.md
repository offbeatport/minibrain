# Observability

minibrain sends nothing anywhere by default. Three opt-in outputs feed the customer's own monitoring:

| Output | Off by default; turned on by | Carries |
|---|---|---|
| OpenTelemetry export (OTLP over HTTP, protobuf) | Settings → Security, `minibrain.yaml` or `OTEL_EXPORTER_OTLP_*` | One span per `/v1` request, and metrics |
| Prometheus `/metrics` | A scrape token or scrape addresses in `minibrain.yaml` or the environment | The same metrics |
| JSON logs on standard output | `MINIBRAIN_LOG_FORMAT=json` or `logging.format: json` | One line per log event |

None of them ever carries a prompt, an answer or an API key. Settings → This install shows which are on.

Monitor → Overview shows the same traffic inside minibrain, from the request logs: requests per minute, error rate,
p50 / p95 latency and tokens per model over a time range, and a per-model table. Request logs are always written,
metadata only; inputs and answers are kept only for models that turn it on ([security](security.md#request-logs)).

## OpenTelemetry export

Settings → Security → OpenTelemetry export, as admin policies (audited, and locked when set in `minibrain.yaml` or the
environment):

| Policy | `minibrain.yaml` (`policy:`) | Standard variable | Default |
|---|---|---|---|
| OpenTelemetry export | `otel_protocol: http/protobuf` | `OTEL_EXPORTER_OTLP_PROTOCOL` | `off` |
| Collector endpoint | `otel_endpoint: https://otel-collector.internal:4318` | `OTEL_EXPORTER_OTLP_ENDPOINT` | empty |
| Collector headers | `otel_headers: Authorization=Bearer …` | `OTEL_EXPORTER_OTLP_HEADERS` | empty |
| Service name | `otel_service_name: minibrain-eu` | `OTEL_SERVICE_NAME` | `minibrain` |
| Collector CA bundle | `otel_ca_bundle: /etc/minibrain/collector-ca.pem` | `OTEL_EXPORTER_OTLP_CERTIFICATE` | system CAs |

- Traces go to `<endpoint>/v1/traces` and metrics to `<endpoint>/v1/metrics`. `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and
  `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` replace either URL; `OTEL_TRACES_EXPORTER=none` or `OTEL_METRICS_EXPORTER=none`
  drops a signal. Setting an endpoint variable turns export on; `OTEL_SDK_DISABLED=true` turns it off.
- The SDK also reads `OTEL_EXPORTER_OTLP_TIMEOUT`, `OTEL_EXPORTER_OTLP_COMPRESSION` (`gzip`),
  `OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE` and `OTEL_EXPORTER_OTLP_CLIENT_KEY` (mTLS), `OTEL_METRIC_EXPORT_INTERVAL`
  (milliseconds, 60000 by default), `OTEL_BSP_*` for span batching and `OTEL_RESOURCE_ATTRIBUTES`.
- Only `http/protobuf` is supported; no gRPC. Any other `OTEL_EXPORTER_OTLP_PROTOCOL` leaves export off and logs why.
- Header values are encrypted at rest with the install's master key (like connection secrets), never returned by the
  API and never written to the audit log; the UI and the audit log show header names only. Values come URL-decoded,
  as the OTLP specification asks (`X-Tenant=acme%20corp`).
- The collector is the only destination. The exporter ignores `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and `.netrc`,
  does not follow redirects, and is not subject to the network policy: like the SIEM, an admin configured it, so it is
  reached even when the network policy is Offline. Settings → This install lists both URLs.
- Changes in the UI apply within 5 seconds, without a restart. The last batch is flushed on shutdown.
- Main exports with the UI settings. A standalone gateway (`minibrain gateway`) has no database, so it reads the same
  settings from its own `minibrain.yaml` and environment.

### Spans

One SERVER span per `/v1` request, following the
[OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/). An incoming W3C
`traceparent` header makes it a child of the caller's trace.

| Attribute | Value |
|---|---|
| Span name | `chat <requested model>` for chat completions, otherwise `<method> <route>` |
| `gen_ai.operation.name` | `chat` |
| `gen_ai.provider.name` | `minibrain` |
| `gen_ai.request.model` | The model as requested, such as `support-triage` or `support-triage@3` |
| `gen_ai.response.model` | The version that answered, such as `support-triage@3`, or the base model id |
| `gen_ai.response.id` | The completion id (`chatcmpl-…`), the same as in Monitor → Requests and `/v1/feedback` |
| `gen_ai.request.max_tokens` | The token limit applied |
| `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` | Tokens in and out |
| `gen_ai.response.finish_reasons` | `["stop"]` or `["length"]` |
| `error.type` | The OpenAI error code (`invalid_json`, `schema_mismatch`) or the status code (`404`); the exception class when the request crashed. Spans with a 5xx status are marked as errors |
| `server.address`, `server.port`, `url.scheme` | From the request's `Host` |
| `http.request.method`, `http.route`, `http.response.status_code` | The HTTP side |
| `minibrain.model.slug`, `minibrain.model.version` | The custom model and version |
| `minibrain.api_key.id` | The id of the API key used (never the key) |

Resource: `service.name` (the Service name policy), `service.version` (the minibrain version), `service.instance.id`
(host name and a random suffix per process), plus anything in `OTEL_RESOURCE_ATTRIBUTES`.

### Metrics

| OpenTelemetry name | Prometheus name | Type | Attributes |
|---|---|---|---|
| `gen_ai.client.operation.duration` (s) | `gen_ai_client_operation_duration_seconds` | Histogram | `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, `error.type` |
| `gen_ai.client.token.usage` ({token}) | `gen_ai_client_token_usage` | Histogram | as above, plus `gen_ai.token.type` (`input`, `output`); successful calls only |
| `minibrain.gateway.requests` ({request}) | `minibrain_gateway_requests_total` | Counter | `http.route`, `http.response.status_code`, `gen_ai.request.model` |
| `minibrain.jobs.queued` ({job}) | `minibrain_jobs_queued` | Gauge | `minibrain.job.kind`; only kinds with queued jobs |
| `minibrain.jobs.queued.oldest_age` (s) | `minibrain_jobs_queued_oldest_age_seconds` | Gauge | none |
| `minibrain.workers.online` ({worker}) | `minibrain_workers_online` | Gauge | `minibrain.pool` |

- Bucket boundaries follow the GenAI conventions: 0.01 to 81.92 seconds doubling, and 1 to 67,108,864 tokens by
  powers of four.
- `gen_ai.request.model` is `_unknown` on metrics when the model does not exist or the key was refused, so random model
  names cannot grow the number of series. Spans keep the requested name.
- Each process reports its own `/v1` traffic. Job and worker gauges come from main's database; with several mains,
  each reports them, so take the `max` across instances.

## Prometheus

`/metrics` answers only when access to it is configured, and needs no user session. Set it like the trusted proxy
addresses, in `minibrain.yaml` or the environment:

```yaml
metrics:
  addresses: [10.0.4.0/24, 10.0.9.15]     # only these clients may scrape
  token_file: /run/secrets/metrics-token   # the scraper sends Authorization: Bearer <token>
```

| Variable | Instead of |
|---|---|
| `MINIBRAIN_METRICS_TOKEN` | `metrics.token_file`; at least 16 characters |
| `MINIBRAIN_METRICS_ADDRESSES` | `metrics.addresses`, comma separated |

- With neither, `/metrics` is a 404. With both, a scrape needs the token and an allowed address.
- A wrong or missing token gets a 401 with `WWW-Authenticate: Bearer`; another address gets a 403. The address is the
  connection's, or the forwarded one when the request comes through a proxy in `auth.proxy.addresses`.
- A token written in `minibrain.yaml` itself is refused at start: keep it in a file or the environment.
- Text format 0.0.4. Standalone gateways serve the same endpoint with their own `/v1` metrics.

```yaml
scrape_configs:
  - job_name: minibrain
    scheme: https
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/minibrain-token
    static_configs:
      - targets: ["minibrain.internal:443"]
  - job_name: minibrain-gateways
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/minibrain-token
    static_configs:
      - targets: ["gateway-1.internal:8100", "gateway-2.internal:8100"]
```

## JSON logs

`MINIBRAIN_LOG_FORMAT=json` (or `logging.format: json` in `minibrain.yaml`) writes one JSON object per line to
standard output, from `serve`, `gateway`, `worker` and `engine`. Plain text stays the default.

```json
{"time": "2026-11-03T12:34:56.789Z", "level": "info", "logger": "uvicorn.access", "message": "10.0.4.7:51022 - \"POST /v1/chat/completions HTTP/1.1\" 200", "request_id": "6f1c…", "response_id": "chatcmpl-…", "client": "10.0.4.7:51022", "method": "POST", "path": "/v1/chat/completions", "http_version": "1.1", "status": 200}
```

| Field | Value |
|---|---|
| `time` | UTC, milliseconds |
| `level`, `logger`, `message` | As logged |
| `request_id` | Every HTTP request's id: the caller's `X-Request-ID` when it is 1–128 letters, digits, `.`, `_`, `:` or `-`, otherwise a new one. Every response carries it back in `X-Request-ID` |
| `response_id` | The completion id, once a `/v1/chat/completions` call has answered |
| `client`, `method`, `path`, `http_version`, `status` | On access lines |
| `exception` | The traceback, when there is one |

## Example collector

An [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/) inside the network receives minibrain's export
and passes traces to Tempo or Jaeger and metrics to Prometheus:

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
        tls:
          cert_file: /etc/otelcol/tls.crt
          key_file: /etc/otelcol/tls.key
        auth:
          authenticator: bearertokenauth

extensions:
  bearertokenauth:
    token: ${env:MINIBRAIN_COLLECTOR_TOKEN}

processors:
  batch: {}
  memory_limiter:
    check_interval: 1s
    limit_percentage: 80

exporters:
  otlp/tempo:
    endpoint: tempo.internal:4317
  prometheusremotewrite:
    endpoint: https://prometheus.internal/api/v1/write

service:
  extensions: [bearertokenauth]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [otlp/tempo]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [prometheusremotewrite]
```

minibrain's side, in `minibrain.yaml`:

```yaml
policy:
  otel_protocol: http/protobuf
  otel_endpoint: https://otel-collector.internal:4318
  otel_ca_bundle: /etc/minibrain/collector-ca.pem
```

with `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20<token>` in the environment, or the header entered once in
Settings → Security.

## Grafana

[`grafana/minibrain.json`](grafana/minibrain.json) is a dashboard over the Prometheus metrics above: requests per
minute, error rate and p50 / p95 latency by model, tokens, queued jobs and workers. Import it and pick the Prometheus
data source that scrapes minibrain, directly or through the collector.
