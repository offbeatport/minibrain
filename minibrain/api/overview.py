import math
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import ColumnElement, Integer, case, func, literal_column, or_, select, type_coerce
from sqlalchemy.orm import Session

from minibrain.api.access import viewer
from minibrain.api.deps import SessionDep
from minibrain.api.owners import base_owned, base_token, custom_owned, log_custom_token, split_token
from minibrain.api.request_logs import CLIENT_ERROR, aware, base_names, live_names, model_match
from minibrain.registry.models import RequestLog, now

router = APIRouter(prefix="/api", tags=["requests"])

TOP = 5
TOP_MAX = 8
TARGET_BUCKETS = 60
STEPS = (10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800)
DEFAULT_SPAN = timedelta(hours=1)
EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
OTHER = "other"


class OverviewBucket(BaseModel):
    at: datetime
    seconds: int


class OverviewSeries(BaseModel):
    key: str
    label: str
    custom: bool
    other: bool = False
    deleted: bool = False


class OverviewPoint(BaseModel):
    bucket: int
    series: int
    requests: int
    errors: int
    p50_ms: float | None
    p95_ms: float | None
    prompt_tokens: int
    completion_tokens: int


class OverviewModel(BaseModel):
    key: str
    label: str
    custom: bool
    deleted: bool = False
    requests: int
    errors: int
    error_rate: float | None
    p50_ms: float | None
    p95_ms: float | None
    prompt_tokens: int
    completion_tokens: int
    last_at: datetime | None


class RequestOverview(BaseModel):
    since: datetime
    until: datetime
    bucket_seconds: int
    buckets: list[OverviewBucket]
    series: list[OverviewSeries]
    points: list[OverviewPoint]
    models: list[OverviewModel]


@dataclass(frozen=True)
class Identity:
    slug: str | None
    base: str | None


@dataclass
class Partition:
    total: int = 0
    errors: int = 0
    prompt: int = 0
    completion: int = 0
    p50: float | None = None
    p95: float | None = None
    p99: float | None = None
    last_at: datetime | None = None


def integer(value: int) -> ColumnElement[int]:
    return type_coerce(literal_column(str(int(value))), Integer)


def step_for(span: timedelta) -> int:
    wanted = span.total_seconds() / TARGET_BUCKETS
    return next((step for step in STEPS if step >= wanted), STEPS[-1])


def aligned(moment: datetime, step: int) -> datetime:
    seconds = (moment - EPOCH).total_seconds()
    return EPOCH + timedelta(seconds=math.floor(seconds / step) * step)


def bucket_of(column: Any, edges: Sequence[datetime], low: int, high: int) -> ColumnElement[int]:
    if low == high:
        return integer(low)
    middle = (low + high + 1) // 2
    return case(
        (column < edges[middle], bucket_of(column, edges, low, middle - 1)),
        else_=bucket_of(column, edges, middle, high),
    )


def same_model(item: Identity) -> ColumnElement[bool]:
    if item.slug is not None:
        return custom_owned(RequestLog.model_slug, RequestLog.model_id, item.slug)
    return base_owned(item.base or "")


def series_of(top: Sequence[Identity]) -> ColumnElement[int]:
    whens = [(same_model(item), integer(index)) for index, item in enumerate(top)]
    return case(*whens, else_=integer(len(top)))


def failed() -> ColumnElement[int]:
    return case((RequestLog.status >= CLIENT_ERROR, 1), else_=0)


def ranked(inner: Any, keys: list[Any], extra: dict[str, Any]) -> Any:
    measures = {
        "rank": func.row_number().over(partition_by=keys, order_by=inner.c.latency_ms),
        "total": func.count().over(partition_by=keys),
        "errors": func.sum(inner.c.failed).over(partition_by=keys),
        "prompt": func.sum(inner.c.prompt_tokens).over(partition_by=keys),
        "completion": func.sum(inner.c.completion_tokens).over(partition_by=keys),
    }
    measures |= {name: value.over(partition_by=keys) for name, value in extra.items()}
    labelled = [value.label(name) for name, value in measures.items()]
    middle = select(*keys, inner.c.latency_ms, *labelled).subquery()
    total = middle.c.total
    picks = or_(
        middle.c.rank == 1,
        middle.c.rank == (total + 1) // 2,
        middle.c.rank == (total * 95 + 99) // 100,
        middle.c.rank == (total * 99 + 99) // 100,
    )
    return select(middle).where(picks)


def partitions(rows: Sequence[Any], key: Any) -> dict[Any, Partition]:
    found: dict[Any, Partition] = {}
    for row in rows:
        part = found.setdefault(key(row), Partition())
        part.total, part.errors = int(row.total), int(row.errors or 0)
        part.prompt, part.completion = int(row.prompt or 0), int(row.completion or 0)
        if row.rank == (part.total + 1) // 2:
            part.p50 = float(row.latency_ms)
        if row.rank == (part.total * 95 + 99) // 100:
            part.p95 = float(row.latency_ms)
        if row.rank == (part.total * 99 + 99) // 100:
            part.p99 = float(row.latency_ms)
        if getattr(row, "last_at", None) is not None:
            part.last_at = aware(row.last_at)
    return found


def shared_columns() -> list[Any]:
    return [
        RequestLog.latency_ms.label("latency_ms"),
        failed().label("failed"),
        RequestLog.prompt_tokens.label("prompt_tokens"),
        RequestLog.completion_tokens.label("completion_tokens"),
    ]


def model_rows(session: Session, where: Sequence[ColumnElement[bool]]) -> list[tuple[Identity, Partition]]:
    identity = [log_custom_token().label("slug"), base_token().label("base"), RequestLog.at.label("at")]
    sub = select(*identity, *shared_columns()).where(*where).subquery()
    query = ranked(sub, [sub.c.slug, sub.c.base], {"last_at": func.max(sub.c.at)})
    found = partitions(list(session.execute(query)), lambda row: Identity(row.slug, row.base))
    return sorted(found.items(), key=lambda item: (-item[1].total, str(item[0].base or item[0].slug)))


def series_points(
    session: Session, where: Sequence[ColumnElement[bool]], top: Sequence[Identity], edges: Sequence[datetime]
) -> list[OverviewPoint]:
    position = [bucket_of(RequestLog.at, edges, 0, len(edges) - 1).label("bucket"), series_of(top).label("series")]
    sub = select(*position, *shared_columns()).where(*where).subquery()
    query = ranked(sub, [sub.c.bucket, sub.c.series], {})
    found = partitions(list(session.execute(query)), lambda row: (int(row.bucket), int(row.series)))
    return [
        OverviewPoint(
            bucket=bucket,
            series=series,
            requests=part.total,
            errors=part.errors,
            p50_ms=part.p50,
            p95_ms=part.p95,
            prompt_tokens=part.prompt,
            completion_tokens=part.completion,
        )
        for (bucket, series), part in sorted(found.items())
    ]


def kept_names(session: Session, column: Any, keys: set[str]) -> dict[str, str]:
    if not keys:
        return {}
    query = select(column, func.max(RequestLog.model_name)).where(column.in_(keys)).group_by(column)
    return {key: name for key, name in session.execute(query) if name}


def names_for(session: Session, identities: Sequence[Identity]) -> dict[Identity, OverviewSeries]:
    slugs = {item.slug for item in identities if item.slug is not None}
    live = live_names(session, slugs) if slugs else {}
    kept = kept_names(session, RequestLog.model_slug, {split_token(slug)[0] for slug in slugs - set(live)})
    wanted = {split_token(item.base)[0] for item in identities if item.base is not None}
    bases = base_names(session, wanted)
    kept_bases = kept_names(session, RequestLog.model, wanted)
    found: dict[Identity, OverviewSeries] = {}
    for item in identities:
        if item.slug is not None:
            slug = split_token(item.slug)[0]
            label = live.get(item.slug) or kept.get(slug) or slug
            found[item] = OverviewSeries(key=item.slug, label=label, custom=True, deleted=item.slug not in live)
        else:
            base, earlier = split_token(item.base or "")
            label = (None if earlier else bases.get(base)) or kept_bases.get(base) or base
            gone = earlier or (base not in bases and base in kept_bases)
            found[item] = OverviewSeries(key=item.base or "", label=label, custom=False, deleted=gone)
    return found


def window_of(
    session: Session, models: list[str], since: datetime | None, until: datetime | None
) -> tuple[datetime, datetime]:
    end = aware(until) if until is not None else now()
    if since is None:
        scope = [model_match(models)] if models else []
        first = session.scalar(select(func.min(RequestLog.at)).where(*scope, RequestLog.at < end))
        start = aware(first) if first is not None else end - DEFAULT_SPAN
    else:
        start = aware(since)
    return (start, end) if start < end else (end - DEFAULT_SPAN, end)


def table_row(series: OverviewSeries, part: Partition) -> OverviewModel:
    return OverviewModel(
        key=series.key,
        label=series.label,
        custom=series.custom,
        deleted=series.deleted,
        requests=part.total,
        errors=part.errors,
        error_rate=part.errors / part.total if part.total else None,
        p50_ms=part.p50,
        p95_ms=part.p95,
        prompt_tokens=part.prompt,
        completion_tokens=part.completion,
        last_at=part.last_at,
    )


@router.get("/requests/overview", dependencies=[Depends(viewer)])
def request_overview(
    session: SessionDep,
    model: Annotated[list[str] | None, Query()] = None,
    since: datetime | None = None,
    until: datetime | None = None,
    top: Annotated[int, Query(ge=1, le=TOP_MAX)] = TOP,
) -> RequestOverview:
    chosen = model or []
    start, end = window_of(session, chosen, since, until)
    step = step_for(end - start)
    first = aligned(start, step)
    count = math.ceil((end - first).total_seconds() / step)
    edges = [first + timedelta(seconds=step * index) for index in range(count)]
    buckets = [OverviewBucket(at=edge, seconds=min(step, math.ceil((end - edge).total_seconds()))) for edge in edges]
    where = [RequestLog.at >= first, RequestLog.at < end, *([model_match(chosen)] if chosen else [])]
    rows = model_rows(session, where)
    names = names_for(session, [identity for identity, _ in rows])
    leaders = [identity for identity, _ in rows[:top]]
    series = [names[identity] for identity in leaders]
    if len(rows) > top:
        series.append(OverviewSeries(key=OTHER, label="Other models", custom=False, other=True))
    return RequestOverview(
        since=first,
        until=end,
        bucket_seconds=step,
        buckets=buckets,
        series=series,
        points=series_points(session, where, leaders, edges) if rows else [],
        models=[table_row(names[identity], part) for identity, part in rows],
    )
