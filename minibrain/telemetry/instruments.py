from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from opentelemetry.metrics import CallbackOptions, Meter, Observation
from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from minibrain.models.hardware import LOCAL_POOL
from minibrain.registry.compute import NODE_FRESH
from minibrain.registry.models import Job, JobStatus, Node, now
from minibrain.telemetry.call import Call

PROVIDER = "minibrain"
UNKNOWN_MODEL = "_unknown"
DURATION_BUCKETS = (0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92)
TOKEN_BUCKETS = (1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864)


@dataclass(frozen=True)
class Outcome:
    route: str
    method: str
    status: int
    seconds: float
    error_type: str | None


def model_attributes(call: Call) -> dict[str, Any]:
    found: dict[str, Any] = {
        "gen_ai.operation.name": call.operation or "",
        "gen_ai.provider.name": PROVIDER,
        "gen_ai.request.model": (call.request_model if call.model_known else None) or UNKNOWN_MODEL,
    }
    if call.response_model:
        found["gen_ai.response.model"] = call.response_model
    return found


class Instruments:
    def __init__(self, meter: Meter) -> None:
        self.duration = meter.create_histogram(
            "gen_ai.client.operation.duration",
            unit="s",
            description="Duration of GenAI operations served through the /v1 gateway",
            explicit_bucket_boundaries_advisory=DURATION_BUCKETS,
        )
        self.tokens = meter.create_histogram(
            "gen_ai.client.token.usage",
            unit="{token}",
            description="Input and output tokens per GenAI operation served through the /v1 gateway",
            explicit_bucket_boundaries_advisory=TOKEN_BUCKETS,
        )
        self.requests = meter.create_counter(
            "minibrain.gateway.requests",
            unit="{request}",
            description="Requests to the /v1 gateway by route, status and model",
        )

    def record(self, call: Call, outcome: Outcome) -> None:
        status = {"http.route": outcome.route, "http.response.status_code": outcome.status}
        self.requests.add(1, status | {"gen_ai.request.model": model_attributes(call)["gen_ai.request.model"]})
        if call.operation is None:
            return
        attributes = model_attributes(call)
        error = outcome.error_type
        self.duration.record(outcome.seconds, attributes | ({"error.type": error} if error else {}))
        if error:
            return
        for kind, used in (("input", call.input_tokens), ("output", call.output_tokens)):
            if used is not None:
                self.tokens.record(used, attributes | {"gen_ai.token.type": kind})


class Gauges:
    def __init__(self, sessions: sessionmaker[Session]) -> None:
        self.sessions = sessions

    def register(self, meter: Meter) -> None:
        meter.create_observable_gauge(
            "minibrain.jobs.queued",
            callbacks=[self.queued],
            unit="{job}",
            description="Jobs waiting for a worker, by kind",
        )
        meter.create_observable_gauge(
            "minibrain.jobs.queued.oldest_age",
            callbacks=[self.oldest],
            unit="s",
            description="Age of the oldest job that could run now",
        )
        meter.create_observable_gauge(
            "minibrain.workers.online",
            callbacks=[self.workers],
            unit="{worker}",
            description="Workers that reported in the last two minutes, by compute pool",
        )

    def queued(self, _options: CallbackOptions) -> Iterable[Observation]:
        with self.sessions() as session:
            query = select(Job.kind, func.count(Job.id)).where(Job.status == JobStatus.QUEUED).group_by(Job.kind)
            return [Observation(count, {"minibrain.job.kind": str(kind)}) for kind, count in session.execute(query)]

    def oldest(self, _options: CallbackOptions) -> Iterable[Observation]:
        with self.sessions() as session:
            runnable = (Job.status == JobStatus.QUEUED, Job.run_after <= now())
            oldest = session.scalar(select(func.min(Job.run_after)).where(*runnable))
        return [Observation(0.0 if oldest is None else max((now() - oldest).total_seconds(), 0.0))]

    def workers(self, _options: CallbackOptions) -> Iterable[Observation]:
        with self.sessions() as session:
            fresh = session.scalars(select(Node).where(Node.seen_at >= now() - NODE_FRESH))
            counts = {LOCAL_POOL: 0}
            for node in fresh:
                counts[node.pool] = counts.get(node.pool, 0) + ("worker" in node.roles)
        return [Observation(count, {"minibrain.pool": pool}) for pool, count in sorted(counts.items())]
