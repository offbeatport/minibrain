import math
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import ColumnElement, and_, func, or_, select
from sqlalchemy.orm import Session

from minibrain.api.access import viewer
from minibrain.api.deps import SessionDep
from minibrain.api.overview import aligned, bucket_of, failed, integer, partitions, ranked, shared_columns
from minibrain.api.request_logs import CLIENT_ERROR, aware
from minibrain.models.placement import pools_of
from minibrain.registry.compute import live_engines
from minibrain.registry.models import ApiKey, AuditEvent, Model, RequestLog, now
from minibrain.registry.models import BaseModel as BaseRow
from minibrain.registry.service import no_model
from minibrain.tasks.service import serving_base

router = APIRouter(prefix="/api")

TrafficRange = Literal["24h", "7d", "30d"]
HOUR = 3600
DAY = 24 * HOUR
USUAL_DAYS = 30
USUAL_MINIMUM = 20
CALLERS = 10
STATUS_LABELS = {
    400: "Bad request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not found",
    408: "Timed out",
    409: "Conflict",
    413: "Too large",
    422: "Invalid request",
    429: "Too many requests",
    499: "Closed by the caller",
    500: "Server error",
    502: "Bad gateway",
    503: "Unavailable",
    504: "Timed out",
}


class TrafficStats(BaseModel):
    requests: int
    errors: int
    error_rate: float | None
    p50_ms: float | None
    p95_ms: float | None
    p99_ms: float | None
    device_seconds: float


class TrafficVersion(TrafficStats):
    version: int | None
    live: bool


class TrafficPoint(TrafficStats):
    bucket: int
    version: int | None


class TrafficBucket(TrafficStats):
    at: datetime


class TrafficMarker(BaseModel):
    at: datetime
    kind: Literal["deploy", "undeploy", "live"]
    version: int | None
    label: str


class TrafficStatus(BaseModel):
    status: int
    label: str
    requests: int
    last_at: datetime


class TrafficCaller(BaseModel):
    key_id: int | None
    name: str | None
    prefix: str | None
    revoked: bool
    requests: int
    errors: int
    error_rate: float | None


class TrafficReplica(BaseModel):
    host: str
    pool: str
    engine: str
    state: str


class ModelTrafficReport(BaseModel):
    range: TrafficRange
    since: datetime
    until: datetime
    bucket_seconds: int
    buckets: list[TrafficBucket]
    versions: list[TrafficVersion]
    points: list[TrafficPoint]
    totals: TrafficStats
    previous: TrafficStats | None
    usual_error_rate: float | None
    markers: list[TrafficMarker]
    errors: list[TrafficStatus]
    callers: list[TrafficCaller]
    replicas: list[TrafficReplica]


@dataclass(frozen=True)
class Subject:
    target: str
    scope: ColumnElement[bool]
    custom: Model | None
    base: BaseRow | None

    @property
    def serving_base(self) -> str:
        if self.custom is not None:
            return serving_base(self.custom)
        return self.base.id if self.base is not None else self.target

    @property
    def pools(self) -> set[str]:
        found = self.custom or self.base
        return pools_of(found) if found is not None else set()

    @property
    def deployed(self) -> bool:
        found = self.custom or self.base
        return bool(found and found.deployed)

    def live(self, version: int | None) -> bool:
        if not self.deployed:
            return False
        current = self.custom.current_version if self.custom is not None else None
        return version == current


def subject_of(session: Session, name: str) -> Subject:
    custom = session.scalar(select(Model).where(Model.slug == name))
    if custom is not None:
        return Subject(custom.slug, RequestLog.model_id == custom.id, custom, None)
    base = session.get(BaseRow, name)
    if base is None:
        raise no_model(session, name)
    scope = and_(RequestLog.model_slug.is_(None), RequestLog.model == base.id, RequestLog.at >= base.created_at)
    return Subject(base.id, scope, None, base)


def window(span: TrafficRange, moment: datetime) -> tuple[datetime, int]:
    if span == "24h":
        return aligned(moment, HOUR) - timedelta(hours=23), HOUR
    midnight = aligned(moment, DAY)
    if span == "7d":
        return midnight - timedelta(days=6), 6 * HOUR
    return midnight - timedelta(days=29), DAY


def edges_of(start: datetime, until: datetime, step: int) -> list[datetime]:
    count = max(1, math.ceil((until - start).total_seconds() / step))
    return [start + timedelta(seconds=step * index) for index in range(count)]


def stats_from(total: int, errors: int, p50: float | None, p95: float | None, p99: float | None, device: float) -> dict:
    return {
        "requests": total,
        "errors": errors,
        "error_rate": errors / total if total else None,
        "p50_ms": p50,
        "p95_ms": p95,
        "p99_ms": p99,
        "device_seconds": round(device / 1000, 3),
    }


EMPTY = stats_from(0, 0, None, None, None, 0.0)


def grouped_stats(
    session: Session, where: Sequence[ColumnElement[bool]], keys: dict[str, Any]
) -> dict[tuple[Any, ...], dict]:
    labelled = [column.label(name) for name, column in keys.items()]
    sub = select(*labelled, *shared_columns()).where(*where).subquery()
    columns = [sub.c[name] for name in keys]
    query = ranked(sub, columns, {"device": func.sum(sub.c.latency_ms)})
    rows = list(session.execute(query))

    def key(row: Any) -> tuple[Any, ...]:
        return tuple(getattr(row, name) for name in keys)

    device = {key(row): float(row.device or 0) for row in rows}
    found = partitions(rows, key)
    return {
        target: stats_from(part.total, part.errors, part.p50, part.p95, part.p99, device.get(target, 0.0))
        for target, part in found.items()
    }


def overall(session: Session, where: Sequence[ColumnElement[bool]]) -> dict:
    found = grouped_stats(session, where, {"everything": integer(0)})
    return next(iter(found.values()), EMPTY)


def previous_stats(session: Session, subject: Subject, start: datetime, until: datetime) -> TrafficStats | None:
    earlier = session.scalar(select(func.count()).select_from(RequestLog).where(subject.scope, RequestLog.at < start))
    if not earlier:
        return None
    before = start - (until - start)
    return TrafficStats(**overall(session, [subject.scope, RequestLog.at >= before, RequestLog.at < start]))


def usual_error_rate(session: Session, scope: ColumnElement[bool], until: datetime) -> float | None:
    day_ago = until - timedelta(days=1)
    where = [scope, RequestLog.at >= day_ago - timedelta(days=USUAL_DAYS), RequestLog.at < day_ago]
    row = session.execute(select(func.count(), func.sum(failed())).where(*where)).one()
    total, errors = int(row[0] or 0), int(row[1] or 0)
    if total < USUAL_MINIMUM:
        return None
    return errors / total


def marker_label(event: AuditEvent, version: int | None) -> tuple[Literal["deploy", "undeploy", "live"], str]:
    if event.action == "version.promote":
        return "live", f"v{version} deployed"
    if event.action == "model.undeploy":
        return "undeploy", "Undeployed"
    return "deploy", f"Deployed with v{version}" if version is not None else "Deployed"


def number_after_at(target: str) -> int | None:
    _, _, number = target.rpartition("@")
    return int(number) if number.isdigit() else None


def markers_of(session: Session, subject: Subject, start: datetime, until: datetime) -> list[TrafficMarker]:
    own = and_(AuditEvent.target == subject.target, AuditEvent.action.in_(("model.deploy", "model.undeploy")))
    matching: ColumnElement[bool] = own
    if subject.custom is not None:
        promoted = and_(AuditEvent.action == "version.promote", AuditEvent.target.like(f"{subject.target}@%"))
        matching = or_(own, promoted)
    query = (
        select(AuditEvent)
        .where(matching, AuditEvent.at >= start, AuditEvent.at < until)
        .order_by(AuditEvent.at, AuditEvent.id)
    )
    found: list[TrafficMarker] = []
    for event in session.scalars(query):
        if event.action == "version.promote":
            version = number_after_at(event.target)
        else:
            raw = (event.detail or {}).get("version")
            version = raw if isinstance(raw, int) else None
        kind, label = marker_label(event, version)
        found.append(TrafficMarker(at=aware(event.at), kind=kind, version=version, label=label))
    return found


def status_label(status: int) -> str:
    return f"{status} {STATUS_LABELS.get(status, 'Error')}"


def errors_of(session: Session, where: Sequence[ColumnElement[bool]]) -> list[TrafficStatus]:
    query = (
        select(RequestLog.status, func.count(), func.max(RequestLog.at))
        .where(*where, RequestLog.status >= CLIENT_ERROR)
        .group_by(RequestLog.status)
    )
    rows = sorted(session.execute(query), key=lambda row: (-int(row[1]), int(row[0])))
    return [
        TrafficStatus(status=int(status), label=status_label(int(status)), requests=int(count), last_at=aware(last))
        for status, count, last in rows
    ]


def callers_of(session: Session, where: Sequence[ColumnElement[bool]]) -> list[TrafficCaller]:
    query = select(RequestLog.key_id, func.count(), func.sum(failed())).where(*where).group_by(RequestLog.key_id)
    rows = sorted(session.execute(query), key=lambda row: (-int(row[1]), row[0] is None, row[0] or 0))[:CALLERS]
    ids = [row[0] for row in rows if row[0] is not None]
    keys = {key.id: key for key in session.scalars(select(ApiKey).where(ApiKey.id.in_(ids)))} if ids else {}
    found: list[TrafficCaller] = []
    for key_id, count, errors in rows:
        total, broken = int(count), int(errors or 0)
        key = keys.get(key_id) if key_id is not None else None
        found.append(
            TrafficCaller(
                key_id=key_id,
                name=key.name if key is not None else None,
                prefix=key.prefix if key is not None else None,
                revoked=key_id is not None and key is None,
                requests=total,
                errors=broken,
                error_rate=broken / total if total else None,
            )
        )
    return found


def replicas_of(session: Session, base: str, pools: set[str]) -> list[TrafficReplica]:
    return [
        TrafficReplica(
            host=replica.node_id.split("/", 1)[-1], pool=replica.pool, engine=replica.engine, state=replica.state
        )
        for replica in live_engines(session)
        if replica.base_model == base and replica.pool in pools
    ]


def version_order(version: int | None) -> tuple[bool, int]:
    return version is None, -(version or 0)


def point_order(item: tuple[tuple[Any, ...], dict]) -> tuple[int, bool, int]:
    index, version = item[0]
    return (int(index), *version_order(version))


def traffic_report(session: Session, name: str, span: TrafficRange) -> ModelTrafficReport:
    subject = subject_of(session, name)
    until = now()
    start, step = window(span, until)
    edges = edges_of(start, until, step)
    where = [subject.scope, RequestLog.at >= start, RequestLog.at < until]
    bucket = bucket_of(RequestLog.at, edges, 0, len(edges) - 1)
    per_bucket = grouped_stats(session, where, {"bucket": bucket})
    per_version = grouped_stats(session, where, {"version": RequestLog.version})
    per_point = grouped_stats(session, where, {"bucket": bucket, "version": RequestLog.version})
    return ModelTrafficReport(
        range=span,
        since=start,
        until=until,
        bucket_seconds=step,
        buckets=[TrafficBucket(at=edge, **per_bucket.get((index,), EMPTY)) for index, edge in enumerate(edges)],
        versions=[
            TrafficVersion(version=version, live=subject.live(version), **stats)
            for (version,), stats in sorted(per_version.items(), key=lambda item: version_order(item[0][0]))
        ],
        points=[
            TrafficPoint(bucket=int(index), version=version, **stats)
            for (index, version), stats in sorted(per_point.items(), key=point_order)
        ],
        totals=TrafficStats(**overall(session, where)),
        previous=previous_stats(session, subject, start, until),
        usual_error_rate=usual_error_rate(session, subject.scope, until),
        markers=markers_of(session, subject, start, until),
        errors=errors_of(session, where),
        callers=callers_of(session, where),
        replicas=replicas_of(session, subject.serving_base, subject.pools) if subject.deployed else [],
    )


@router.get(
    "/models/{name}/traffic",
    dependencies=[Depends(viewer)],
    summary="Chart a model's requests by version",
    description="Requests, errors, latency and device time per bucket and per version for the range, with what "
    "changed in it, the errors by status, the busiest keys and the replicas serving it.",
)
def read_model_traffic(
    name: str, session: SessionDep, span: Annotated[TrafficRange, Query(alias="range")] = "30d"
) -> ModelTrafficReport:
    return traffic_report(session, name, span)
