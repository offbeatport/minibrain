import csv
import io
import json
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import ColumnElement, String, cast, func, or_, select
from sqlalchemy.orm import Session, sessionmaker
from starlette.types import ASGIApp, Receive, Scope, Send

from minibrain.api.access import admin
from minibrain.api.deps import SessionDep
from minibrain.policy import load as load_policy
from minibrain.redaction import redact
from minibrain.registry.audit_chain import ChainReport, head_of, verify
from minibrain.registry.models import PEER_ADDRESS, AuditEvent, now
from minibrain.registry.service import NotFoundError
from minibrain.siem import target_of, waiting

router = APIRouter(prefix="/api/audit")

PAGE_SIZE = 50
PAGE_MAX = 500
EXPORT_BATCH = 1000
EXPORT_COLUMNS = ("id", "seq", "at", "actor", "ip", "action", "target", "detail", "prev_hash", "hash")
FORMULA_START = ("=", "+", "-", "@", "\t", "\r")
MEDIA_TYPES = {"csv": "text/csv; charset=utf-8", "jsonl": "application/x-ndjson"}


class PeerAddress:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        client = scope.get("client") if scope["type"] == "http" else None
        token = PEER_ADDRESS.set(client[0] if client else None)
        try:
            await self.app(scope, receive, send)
        finally:
            PEER_ADDRESS.reset(token)


class AuditInfo(BaseModel):
    id: int
    at: datetime
    actor: str
    ip: str | None
    action: str
    target: str
    detail: dict[str, Any]
    seq: int | None
    prev_hash: str | None
    hash: str | None


class AuditPage(BaseModel):
    events: list[AuditInfo]
    total: int
    newer: int
    older_cursor: int | None
    newer_cursor: int | None


class AuditFacet(BaseModel):
    value: str
    count: int


class AuditFacets(BaseModel):
    actions: list[AuditFacet]
    actors: list[AuditFacet]


class ChainBreakInfo(BaseModel):
    seq: int
    event_id: int | None
    reason: str


class SiemInfo(BaseModel):
    target: str | None
    forwarded_seq: int
    forwarded_at: datetime | None
    error: str | None
    waiting: int


class AuditChainInfo(BaseModel):
    verified: bool
    events: int
    first_seq: int | None
    last_seq: int
    anchor_seq: int
    pending: int
    broken: ChainBreakInfo | None
    checked_at: datetime
    siem: SiemInfo


@dataclass(frozen=True)
class AuditFilter:
    actions: list[str]
    actors: list[str]
    since: datetime | None
    until: datetime | None
    search: str

    def conditions(self) -> list[ColumnElement[bool]]:
        found: list[ColumnElement[bool]] = []
        if self.actions:
            found.append(AuditEvent.action.in_(self.actions))
        if self.actors:
            found.append(AuditEvent.actor.in_(self.actors))
        if self.since is not None:
            found.append(AuditEvent.at >= self.since)
        if self.until is not None:
            found.append(AuditEvent.at < self.until)
        words = self.search.strip().lower()
        if words:
            columns = (AuditEvent.actor, AuditEvent.action, AuditEvent.target, AuditEvent.ip)
            fields = [*columns, cast(AuditEvent.detail, String)]
            found.append(or_(*(func.lower(field).contains(words, autoescape=True) for field in fields)))
        return found


def audit_filter(
    action: Annotated[list[str] | None, Query()] = None,
    actor: Annotated[list[str] | None, Query()] = None,
    since: datetime | None = None,
    until: datetime | None = None,
    q: str = "",
) -> AuditFilter:
    return AuditFilter(actions=action or [], actors=actor or [], since=since, until=until, search=q)


FilterDep = Annotated[AuditFilter, Depends(audit_filter)]


def event_info(event: AuditEvent) -> AuditInfo:
    return AuditInfo(
        id=event.id,
        at=event.at,
        actor=event.actor,
        ip=event.ip,
        action=event.action,
        target=event.target,
        detail=redact(dict(event.detail)),
        seq=event.seq,
        prev_hash=event.prev_hash,
        hash=event.hash,
    )


def matching(session: Session, conditions: list[ColumnElement[bool]]) -> int:
    return int(session.scalar(select(func.count(AuditEvent.id)).where(*conditions)) or 0)


def newest(session: Session, conditions: list[ColumnElement[bool]], size: int) -> list[AuditEvent]:
    return list(session.scalars(select(AuditEvent).where(*conditions).order_by(AuditEvent.id.desc()).limit(size)))


def page_rows(
    session: Session, conditions: list[ColumnElement[bool]], before: int | None, after: int | None, size: int
) -> list[AuditEvent]:
    if after is not None:
        query = select(AuditEvent).where(*conditions, AuditEvent.id > after).order_by(AuditEvent.id.asc())
        rows = list(session.scalars(query.limit(size)))
        return rows[::-1] if len(rows) == size else newest(session, conditions, size)
    if before is not None:
        return newest(session, [*conditions, AuditEvent.id < before], size)
    return newest(session, conditions, size)


@router.get("", dependencies=[Depends(admin)], summary="List audit events")
def list_events(
    session: SessionDep,
    found: FilterDep,
    before: int | None = None,
    after: int | None = None,
    limit: int = PAGE_SIZE,
) -> AuditPage:
    conditions = found.conditions()
    rows = page_rows(session, conditions, before, after, max(1, min(limit, PAGE_MAX)))
    total = matching(session, conditions)
    if not rows:
        return AuditPage(events=[], total=total, newer=total, older_cursor=None, newer_cursor=None)
    top, bottom = rows[0].id, rows[-1].id
    newer = matching(session, [*conditions, AuditEvent.id > top])
    older = total - newer - len(rows)
    return AuditPage(
        events=[event_info(event) for event in rows],
        total=total,
        newer=newer,
        older_cursor=bottom if older > 0 else None,
        newer_cursor=top if newer > 0 else None,
    )


@router.get("/facets", dependencies=[Depends(admin)], summary="Count audit events by filter")
def facets(session: SessionDep) -> AuditFacets:
    def counted(column: Any) -> list[AuditFacet]:
        rows = session.execute(select(column, func.count()).group_by(column).order_by(column)).all()
        return [AuditFacet(value=value, count=count) for value, count in rows]

    return AuditFacets(actions=counted(AuditEvent.action), actors=counted(AuditEvent.actor))


def safe_cell(value: Any) -> str:
    text = "" if value is None else str(value)
    return f"'{text}" if text.startswith(FORMULA_START) else text


def exported(event: AuditEvent) -> dict[str, Any]:
    return event_info(event).model_dump(mode="json")


def csv_lines(rows: Iterator[AuditEvent]) -> Iterator[str]:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(EXPORT_COLUMNS)
    for event in rows:
        record = exported(event)
        record["detail"] = json.dumps(record["detail"], sort_keys=True)
        writer.writerow([safe_cell(record[column]) for column in EXPORT_COLUMNS])
        yield buffer.getvalue()
        buffer.seek(0)
        buffer.truncate()
    yield buffer.getvalue()


def jsonl_lines(rows: Iterator[AuditEvent]) -> Iterator[str]:
    for event in rows:
        yield json.dumps(exported(event), sort_keys=True) + "\n"


def export_stream(
    sessions: sessionmaker[Session], conditions: list[ColumnElement[bool]], kind: Literal["csv", "jsonl"]
) -> Iterator[str]:
    with sessions() as session:
        query = select(AuditEvent).where(*conditions).order_by(AuditEvent.id.desc())
        rows = iter(session.scalars(query.execution_options(yield_per=EXPORT_BATCH)))
        yield from (csv_lines(rows) if kind == "csv" else jsonl_lines(rows))


@router.get(
    "/export",
    response_class=StreamingResponse,
    responses={200: {"content": {"text/csv": {}}}},
    dependencies=[Depends(admin)],
    summary="Export the audit log",
)
def export(request: Request, found: FilterDep, format: Literal["csv", "jsonl"] = "csv") -> StreamingResponse:
    name = f"minibrain-audit-{now().strftime('%Y%m%d-%H%M%S')}.{format}"
    return StreamingResponse(
        export_stream(request.app.state.sessions, found.conditions(), format),
        media_type=MEDIA_TYPES[format],
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


def chain_info(report: ChainReport, siem: SiemInfo) -> AuditChainInfo:
    broken = report.broken
    return AuditChainInfo(
        verified=report.verified,
        events=report.events,
        first_seq=report.first_seq,
        last_seq=report.last_seq,
        anchor_seq=report.anchor_seq,
        pending=report.pending,
        broken=ChainBreakInfo(seq=broken.seq, event_id=broken.event_id, reason=broken.reason) if broken else None,
        checked_at=now(),
        siem=siem,
    )


def siem_info(session: Session) -> SiemInfo:
    target = target_of(load_policy(session))
    head = head_of(session)
    return SiemInfo(
        target=target.describe() if target else None,
        forwarded_seq=head.forwarded_seq,
        forwarded_at=head.forwarded_at,
        error=head.forward_error,
        waiting=waiting(session, head.forwarded_seq),
    )


@router.get("/chain", dependencies=[Depends(admin)], summary="Check the audit hash chain")
def chain(session: SessionDep) -> AuditChainInfo:
    return chain_info(verify(session), siem_info(session))


@router.get("/{event_id}", dependencies=[Depends(admin)], summary="Read an audit event")
def event(event_id: int, session: SessionDep) -> AuditInfo:
    found = session.get(AuditEvent, event_id)
    if found is None:
        raise NotFoundError(f"No audit event {event_id}")
    return event_info(found)
