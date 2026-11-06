import math
import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

import pydantic
from fastapi import APIRouter, Depends, Query
from sqlalchemy import ColumnElement, and_, case, false, func, or_, select
from sqlalchemy.orm import Session

from minibrain.api.access import sees_rows, viewer
from minibrain.api.deps import SessionDep
from minibrain.data.feedback import UP
from minibrain.models.registry import base_publisher
from minibrain.policy import bodies_choice
from minibrain.policy import load as load_policy
from minibrain.registry.models import ApiKey, BaseModel, Feedback, FeedbackStatus, Model, RequestLog
from minibrain.registry.service import NotFoundError

router = APIRouter(prefix="/api", tags=["requests"])

PAGE = 50
PAGE_MAX = 200
CLIENT_ERROR = 400
SERVER_ERROR = 500
NO_KEY = "none"
RESPONSE_ID = re.compile(r"chatcmpl-[0-9a-f]{32}")

StatusClass = Literal["ok", "client_error", "server_error"]
BodyState = Literal["kept", "hidden", "missing", "off"]
Facet = Literal["model", "version", "key", "status"]
STATUS_CLASSES: tuple[StatusClass, ...] = ("ok", "client_error", "server_error")


class RequestRow(pydantic.BaseModel):
    id: int
    at: datetime
    model: str
    model_key: str
    model_name: str
    custom: bool
    version: int | None
    contract: int | None = None
    key_id: int | None
    key_name: str | None
    status: int
    status_class: StatusClass
    latency_ms: float
    prompt_tokens: int
    completion_tokens: int
    finish_reason: str | None
    blocked_by: str | None = None
    blocked_for: list[str] = []
    response_id: str | None
    feedback_up: int
    feedback_down: int


class RequestPage(pydantic.BaseModel):
    items: list[RequestRow]
    next_cursor: str | None
    total: int


class RequestFacet(pydantic.BaseModel):
    value: str
    label: str
    count: int
    publisher: str | None = None


class RequestFacets(pydantic.BaseModel):
    total: int
    statuses: dict[str, int]
    models: list[RequestFacet]
    versions: list[RequestFacet]
    keys: list[RequestFacet]


class RequestSummary(pydantic.BaseModel):
    requests: int
    errors: int
    error_rate: float | None
    p50_ms: float | None
    p95_ms: float | None
    prompt_tokens: int
    completion_tokens: int
    retention_days: int
    last_at: datetime | None


class RequestFeedback(pydantic.BaseModel):
    id: int
    rating: Literal["up", "down"]
    status: Literal["pending", "accepted", "rejected"]
    origin: str
    created_at: datetime
    correction: str | None
    comment: str | None


class RequestDetail(RequestRow):
    body: BodyState
    body_locked: bool
    input: str | None
    output: str | None
    feedback: list[RequestFeedback]


def status_class(status: int) -> StatusClass:
    if status < CLIENT_ERROR:
        return "ok"
    return "client_error" if status < SERVER_ERROR else "server_error"


def status_match(chosen: str) -> ColumnElement[bool]:
    if chosen == "ok":
        return RequestLog.status < CLIENT_ERROR
    if chosen == "client_error":
        return and_(RequestLog.status >= CLIENT_ERROR, RequestLog.status < SERVER_ERROR)
    return RequestLog.status >= SERVER_ERROR


def model_match(keys: list[str]) -> ColumnElement[bool]:
    custom = select(Model.id).where(Model.slug.in_(keys))
    return or_(RequestLog.model_id.in_(custom), and_(RequestLog.model_id.is_(None), RequestLog.model.in_(keys)))


def version_match(values: list[str]) -> ColumnElement[bool]:
    pairs = [value.rpartition("@") for value in values]
    chosen = [
        and_(
            RequestLog.model_id.in_(select(Model.id).where(Model.slug == slug)),
            RequestLog.version == int(number),
        )
        for slug, _, number in pairs
        if slug and number.isdigit()
    ]
    return or_(*chosen) if chosen else false()


def key_match(values: list[str]) -> ColumnElement[bool]:
    chosen: list[ColumnElement[bool]] = []
    ids = [int(value) for value in values if value.isdigit()]
    if ids:
        chosen.append(RequestLog.key_id.in_(ids))
    if NO_KEY in values:
        chosen.append(RequestLog.key_id.is_(None))
    return or_(*chosen) if chosen else false()


def text_match(text: str) -> ColumnElement[bool]:
    if RESPONSE_ID.fullmatch(text):
        return RequestLog.response_id == text
    return RequestLog.response_id.icontains(text, autoescape=True)


@dataclass(frozen=True)
class RequestFilter:
    models: list[str]
    versions: list[str]
    keys: list[str]
    statuses: list[str]
    q: str
    since: datetime | None
    until: datetime | None

    def conditions(self, skip: Facet | None = None) -> list[ColumnElement[bool]]:
        where: list[ColumnElement[bool]] = []
        if self.models and skip != "model":
            where.append(model_match(self.models))
        if self.versions and skip != "version":
            where.append(version_match(self.versions))
        if self.keys and skip != "key":
            where.append(key_match(self.keys))
        if self.statuses and skip != "status":
            where.append(or_(*(status_match(chosen) for chosen in self.statuses)))
        if self.q:
            where.append(text_match(self.q))
        if self.since is not None:
            where.append(RequestLog.at >= self.since)
        if self.until is not None:
            where.append(RequestLog.at < self.until)
        return where


def request_filter(
    model: Annotated[list[str] | None, Query()] = None,
    version: Annotated[list[str] | None, Query()] = None,
    key: Annotated[list[str] | None, Query()] = None,
    status: Annotated[list[StatusClass] | None, Query()] = None,
    q: Annotated[str, Query(max_length=200)] = "",
    since: datetime | None = None,
    until: datetime | None = None,
) -> RequestFilter:
    return RequestFilter(
        models=model or [],
        versions=version or [],
        keys=key or [],
        statuses=list(status or []),
        q=q.strip(),
        since=since,
        until=until,
    )


FilterDep = Annotated[RequestFilter, Depends(request_filter)]


def count_requests(session: Session, where: Sequence[ColumnElement[bool]]) -> int:
    return session.scalar(select(func.count()).select_from(RequestLog).where(*where)) or 0


def base_names(session: Session, keys: set[str]) -> dict[str, str]:
    return {key: base.name for key, base in bases_of(session, keys).items()}


def bases_of(session: Session, keys: set[str]) -> dict[str, BaseModel]:
    if not keys:
        return {}
    return {base.id: base for base in session.scalars(select(BaseModel).where(BaseModel.id.in_(keys)))}


Marks = dict[tuple[int | None, str | None], dict[str, int]]


def feedback_marks(session: Session, logs: Sequence[RequestLog]) -> Marks:
    ids = {log.response_id for log in logs if log.response_id and log.model_id is not None}
    if not ids:
        return {}
    query = (
        select(Feedback.model_id, Feedback.response_id, Feedback.rating, func.count())
        .where(Feedback.response_id.in_(ids))
        .group_by(Feedback.model_id, Feedback.response_id, Feedback.rating)
    )
    marks: Marks = {}
    for model_id, response_id, rating, total in session.execute(query):
        marks.setdefault((model_id, response_id), {})[rating] = total
    return marks


def aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def rows_for(session: Session, where: Sequence[ColumnElement[bool]], size: int) -> list[Any]:
    query = (
        select(RequestLog, Model.slug, Model.name, ApiKey.name)
        .outerjoin(Model, RequestLog.model_id == Model.id)
        .outerjoin(ApiKey, RequestLog.key_id == ApiKey.id)
        .where(*where)
    )
    return list(session.execute(query.order_by(RequestLog.id.desc()).limit(size)))


def identity(log: RequestLog, slug: str | None, name: str | None, names: dict[str, str]) -> tuple[str, str]:
    if slug is not None and name is not None:
        return slug, name
    return log.model, names.get(log.model, log.model)


def request_rows(session: Session, found: Sequence[Any]) -> list[RequestRow]:
    logs = [row[0] for row in found]
    marks = feedback_marks(session, logs)
    names = base_names(session, {log.model for log in logs if log.model_id is None})
    items: list[RequestRow] = []
    for log, slug, name, key_name in found:
        model_key, model_name = identity(log, slug, name, names)
        custom = slug is not None
        mark = marks.get((log.model_id, log.response_id), {}) if custom and log.response_id else {}
        items.append(
            RequestRow(
                id=log.id,
                at=aware(log.at),
                model=log.model,
                model_key=model_key,
                model_name=model_name,
                custom=custom,
                version=log.version,
                contract=log.contract,
                key_id=log.key_id,
                key_name=key_name,
                status=log.status,
                status_class=status_class(log.status),
                latency_ms=log.latency_ms,
                prompt_tokens=log.prompt_tokens,
                completion_tokens=log.completion_tokens,
                finish_reason=log.finish_reason,
                blocked_by=str((log.safety or {}).get("model") or "") or None,
                blocked_for=[str(item) for item in (log.safety or {}).get("categories") or []],
                response_id=log.response_id,
                feedback_up=mark.get(UP, 0),
                feedback_down=sum(total for rating, total in mark.items() if rating != UP),
            )
        )
    return items


@router.get("/requests", dependencies=[Depends(viewer)])
def list_requests(
    session: SessionDep,
    filters: FilterDep,
    limit: int = PAGE,
    cursor: Annotated[str | None, Query(pattern=r"^\d{1,18}$")] = None,
    after: Annotated[str | None, Query(pattern=r"^\d{1,18}$")] = None,
) -> RequestPage:
    where = filters.conditions()
    size = max(1, min(limit, PAGE_MAX))
    bounds: list[ColumnElement[bool]] = []
    if cursor is not None:
        bounds.append(RequestLog.id < int(cursor))
    if after is not None:
        bounds.append(RequestLog.id > int(after))
    found = rows_for(session, [*where, *bounds], size + 1)
    shown = found[:size]
    return RequestPage(
        items=request_rows(session, shown),
        next_cursor=str(shown[-1][0].id) if len(found) > size else None,
        total=count_requests(session, where),
    )


def base_facet(base: BaseModel | None, model: str, total: int) -> RequestFacet:
    if base is None:
        return RequestFacet(value=model, label=model, count=total)
    return RequestFacet(value=model, label=base.name, count=total, publisher=base_publisher(base))


def model_facets(session: Session, where: list[ColumnElement[bool]]) -> list[RequestFacet]:
    custom = (
        select(Model.slug, Model.name, func.count())
        .select_from(RequestLog)
        .join(Model, RequestLog.model_id == Model.id)
        .where(*where)
        .group_by(Model.slug, Model.name)
    )
    base = (
        select(RequestLog.model, func.count()).where(RequestLog.model_id.is_(None), *where).group_by(RequestLog.model)
    )
    facets = [RequestFacet(value=slug, label=name, count=total) for slug, name, total in session.execute(custom)]
    found = list(session.execute(base))
    bases = bases_of(session, {model for model, _ in found})
    facets += [base_facet(bases.get(model), model, total) for model, total in found]
    return sorted(facets, key=lambda facet: (-facet.count, facet.label.lower()))


def version_facets(session: Session, where: list[ColumnElement[bool]]) -> list[RequestFacet]:
    query = (
        select(Model.slug, Model.name, RequestLog.version, func.count())
        .select_from(RequestLog)
        .join(Model, RequestLog.model_id == Model.id)
        .where(RequestLog.version.is_not(None), *where)
        .group_by(Model.slug, Model.name, RequestLog.version)
    )
    found = sorted(session.execute(query), key=lambda row: (row[1].lower(), -(row[2] or 0)))
    return [
        RequestFacet(value=f"{slug}@{version}", label=f"{name} v{version}", count=total)
        for slug, name, version, total in found
    ]


def key_facets(session: Session, where: list[ColumnElement[bool]]) -> list[RequestFacet]:
    query = (
        select(RequestLog.key_id, ApiKey.name, func.count())
        .select_from(RequestLog)
        .outerjoin(ApiKey, RequestLog.key_id == ApiKey.id)
        .where(*where)
        .group_by(RequestLog.key_id, ApiKey.name)
    )
    facets = [
        RequestFacet(value=NO_KEY if key_id is None else str(key_id), label=name or "Deleted key", count=total)
        for key_id, name, total in session.execute(query)
    ]
    return sorted(facets, key=lambda facet: (-facet.count, facet.label.lower()))


def status_facets(session: Session, where: list[ColumnElement[bool]]) -> dict[str, int]:
    counts: dict[str, int] = dict.fromkeys(STATUS_CLASSES, 0)
    query = select(RequestLog.status, func.count()).where(*where).group_by(RequestLog.status)
    for status, total in session.execute(query):
        counts[status_class(status)] += total
    return counts


@router.get("/requests/facets", dependencies=[Depends(viewer)])
def request_facets(session: SessionDep, filters: FilterDep) -> RequestFacets:
    return RequestFacets(
        total=count_requests(session, filters.conditions()),
        statuses=status_facets(session, filters.conditions("status")),
        models=model_facets(session, filters.conditions("model")),
        versions=version_facets(session, filters.conditions("version")),
        keys=key_facets(session, filters.conditions("key")),
    )


def latency_at(session: Session, where: list[ColumnElement[bool]], share: float, total: int) -> float | None:
    if total == 0:
        return None
    rank = min(total, max(1, math.ceil(share * total)))
    query = select(RequestLog.latency_ms).where(*where).order_by(RequestLog.latency_ms).offset(rank - 1).limit(1)
    return session.scalar(query)


@router.get("/requests/summary", dependencies=[Depends(viewer)])
def request_summary(session: SessionDep, filters: FilterDep) -> RequestSummary:
    where = filters.conditions()
    failed = case((RequestLog.status >= CLIENT_ERROR, 1), else_=0)
    totals = select(
        func.count(),
        func.coalesce(func.sum(failed), 0),
        func.coalesce(func.sum(RequestLog.prompt_tokens), 0),
        func.coalesce(func.sum(RequestLog.completion_tokens), 0),
    ).where(*where)
    requests, errors, prompt_tokens, completion_tokens = session.execute(totals).one()
    last_at = session.scalar(select(func.max(RequestLog.at)))
    policy = load_policy(session)
    return RequestSummary(
        requests=requests,
        errors=errors,
        error_rate=errors / requests if requests else None,
        p50_ms=latency_at(session, where, 0.5, requests),
        p95_ms=latency_at(session, where, 0.95, requests),
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        retention_days=int(policy["log_retention_days"]),
        last_at=aware(last_at) if last_at is not None else None,
    )


def linked_feedback(session: Session, log: RequestLog, rows: bool) -> list[RequestFeedback]:
    if log.model_id is None or not log.response_id:
        return []
    query = select(Feedback).where(Feedback.model_id == log.model_id, Feedback.response_id == log.response_id)
    return [
        RequestFeedback(
            id=item.id,
            rating="up" if item.rating == UP else "down",
            status=FeedbackStatus(item.status).value,
            origin=item.origin,
            created_at=aware(item.created_at),
            correction=item.correction if rows else None,
            comment=item.comment if rows else None,
        )
        for item in session.scalars(query.order_by(Feedback.id))
    ]


def body_state(session: Session, log: RequestLog, rows: bool) -> tuple[BodyState, bool]:
    model = session.get(Model, log.model_id) if log.model_id is not None else None
    chosen = model.request_bodies if model is not None else bool(load_policy(session)["request_bodies"])
    kept, lock = bodies_choice(session, chosen)
    if log.input is not None or log.output is not None:
        return ("kept" if rows else "hidden"), lock is not None
    return ("missing" if kept else "off"), lock is not None


@router.get("/requests/{request_id}", dependencies=[Depends(viewer)])
def read_request(request_id: int, session: SessionDep) -> RequestDetail:
    found = rows_for(session, [RequestLog.id == request_id], 1)
    if not found:
        raise NotFoundError(f"request {request_id} not found")
    log = found[0][0]
    rows = sees_rows()
    state, locked = body_state(session, log, rows)
    extra = {
        "body": state,
        "body_locked": locked,
        "input": log.input if state == "kept" else None,
        "output": log.output if state == "kept" else None,
        "feedback": linked_feedback(session, log, rows),
    }
    return RequestDetail.model_validate(request_rows(session, found)[0].model_dump() | extra)
