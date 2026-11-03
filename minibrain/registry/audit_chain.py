import hashlib
import json
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from minibrain.redaction import redact
from minibrain.registry.models import AuditChain, AuditEvent

GENESIS = "0" * 64
HEAD = 1
SEAL_BATCH = 500
VERIFY_BATCH = 1000
PRUNE_ACTION = "audit.prune"

Anchors = Callable[[], dict[int, str]]
Head = tuple[int, str]


@dataclass(frozen=True)
class Sealed:
    id: int | None
    seq: int
    prev_hash: str | None
    hash: str | None
    fields: dict[str, Any]


@dataclass(frozen=True)
class ChainBreak:
    seq: int
    event_id: int | None
    reason: str


@dataclass(frozen=True)
class ChainReport:
    events: int
    first_seq: int | None
    last_seq: int
    anchor_seq: int
    pending: int
    broken: ChainBreak | None

    @property
    def verified(self) -> bool:
        return self.broken is None


@dataclass
class Progress:
    first: int | None = None
    anchor: int = 0
    previous: str = GENESIS
    count: int = 0

    @property
    def last(self) -> int:
        return self.anchor + self.count


def stamp(at: datetime) -> str:
    aware = at if at.tzinfo else at.replace(tzinfo=UTC)
    return aware.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def chain_fields(
    seq: int, prev_hash: str, at: datetime, actor: str, ip: str | None, action: str, target: str, detail: Any
) -> dict[str, Any]:
    return {
        "seq": seq,
        "prev_hash": prev_hash,
        "at": stamp(at),
        "actor": actor,
        "ip": ip,
        "action": action,
        "target": target,
        "detail": redact(detail if detail is not None else {}),
    }


def canonical(fields: dict[str, Any]) -> bytes:
    return json.dumps(fields, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")


def digest(fields: dict[str, Any]) -> str:
    return hashlib.sha256(canonical(fields)).hexdigest()


def fields_of(event: AuditEvent, seq: int, prev_hash: str) -> dict[str, Any]:
    return chain_fields(seq, prev_hash, event.at, event.actor, event.ip, event.action, event.target, event.detail)


def head_of(session: Session) -> AuditChain:
    query = select(AuditChain).where(AuditChain.id == HEAD).execution_options(populate_existing=True)
    return session.scalars(query).one()


def lock_head(session: Session) -> AuditChain:
    session.execute(
        update(AuditChain)
        .where(AuditChain.id == HEAD)
        .values(seq=AuditChain.seq)
        .execution_options(synchronize_session=False)
    )
    return head_of(session)


def unsealed(session: Session) -> int:
    return int(session.scalar(select(func.count(AuditEvent.id)).where(AuditEvent.seq.is_(None))) or 0)


def seal(session: Session, limit: int = SEAL_BATCH) -> int:
    if session.scalar(select(AuditEvent.id).where(AuditEvent.seq.is_(None)).limit(1)) is None:
        return 0
    head = lock_head(session)
    query = select(AuditEvent).where(AuditEvent.seq.is_(None)).order_by(AuditEvent.id).limit(limit)
    rows = list(session.scalars(query.execution_options(populate_existing=True)))
    seq, previous = head.seq, head.hash
    for event in rows:
        seq += 1
        fields = fields_of(event, seq, previous)
        event.seq, event.prev_hash = seq, previous
        event.hash = previous = digest(fields)
    head.seq, head.hash = seq, previous
    session.commit()
    return len(rows)


def seal_all(session: Session) -> int:
    total = 0
    while sealed := seal(session):
        total += sealed
    return total


def anchor_of(detail: Any) -> tuple[int, str] | None:
    if not isinstance(detail, dict):
        return None
    seq, cut = detail.get("cut_seq"), detail.get("cut_hash")
    if isinstance(seq, int) and not isinstance(seq, bool) and isinstance(cut, str):
        return seq, cut
    return None


def prune_anchors(session: Session) -> dict[int, str]:
    details = session.scalars(select(AuditEvent.detail).where(AuditEvent.action == PRUNE_ACTION))
    return dict(anchor for detail in details if (anchor := anchor_of(detail)) is not None)


def prune_cut(session: Session, cutoff: datetime, forwarded: int | None) -> tuple[int, str] | None:
    sealed = AuditEvent.seq.is_not(None)
    kept = session.scalar(select(func.min(AuditEvent.seq)).where(sealed, AuditEvent.at >= cutoff))
    bound = head_of(session).seq if kept is None else kept - 1
    if forwarded is not None:
        bound = min(bound, forwarded)
    query = select(AuditEvent.seq, AuditEvent.hash).where(sealed, AuditEvent.seq <= bound)
    found = session.execute(query.order_by(AuditEvent.seq.desc()).limit(1)).first()
    if found is None or found.hash is None:
        return None
    return int(found.seq), str(found.hash)


def span(first: int, last: int) -> str:
    return f"seq {first}" if first == last else f"seq {first} to {last}"


def missing(first: int, last: int) -> str:
    return f"{span(first, last)} {'is' if first == last else 'are'} missing"


def foreign(first: int, last: int) -> str:
    return f"{span(first, last)} {'was' if first == last else 'were'} not sealed by minibrain"


def start(progress: Progress, row: Sealed, anchors: Anchors) -> ChainBreak | None:
    progress.first = row.seq
    if row.seq == 1:
        return None
    cut = anchors().get(row.seq - 1)
    if cut is None:
        return ChainBreak(row.seq, row.id, f"events before seq {row.seq} were deleted without a prune")
    progress.anchor, progress.previous = row.seq - 1, cut
    return None


def check(progress: Progress, row: Sealed) -> ChainBreak | None:
    expected = progress.last + 1
    if row.seq != expected:
        return ChainBreak(expected, None, missing(expected, row.seq - 1))
    if row.prev_hash != progress.previous:
        after_prune = progress.count == 0 and progress.anchor > 0
        source = f"the prune at seq {progress.anchor}" if after_prune else f"seq {row.seq - 1}"
        return ChainBreak(row.seq, row.id, f"its previous hash does not match {source}")
    if row.hash is None or digest(row.fields) != row.hash:
        return ChainBreak(row.seq, row.id, "its contents changed after it was sealed")
    progress.previous = row.hash
    progress.count += 1
    return None


def ending(progress: Progress, head: Head, latest: Callable[[], Head], anchors: Anchors) -> ChainBreak | None:
    head_seq, head_hash = head
    if progress.first is None:
        if head_seq == 0:
            return None
        cuts = anchors()
        if cuts.get(head_seq) == head_hash:
            progress.anchor = head_seq
            return None
        first = max((seq for seq in cuts if seq < head_seq), default=0) + 1
        return ChainBreak(first, None, missing(first, head_seq))
    if progress.last < head_seq:
        return ChainBreak(progress.last + 1, None, missing(progress.last + 1, head_seq))
    if progress.last > head_seq:
        head_seq, head_hash = latest()
        if progress.last > head_seq:
            return ChainBreak(head_seq + 1, None, foreign(head_seq + 1, progress.last))
        if progress.last < head_seq:
            return None
    if progress.previous != head_hash:
        return ChainBreak(head_seq, None, "the newest event does not match the chain head")
    return None


def walk(rows: Iterable[Sealed], head: Head, latest: Callable[[], Head], anchors: Anchors, pending: int) -> ChainReport:
    progress = Progress()
    broken: ChainBreak | None = None
    for row in rows:
        broken = start(progress, row, anchors) if progress.first is None else None
        broken = broken or check(progress, row)
        if broken is not None:
            break
    else:
        broken = ending(progress, head, latest, anchors)
    return ChainReport(progress.count, progress.first, progress.last, progress.anchor, pending, broken)


def stored(session: Session) -> Iterator[Sealed]:
    columns = (
        AuditEvent.id,
        AuditEvent.seq,
        AuditEvent.prev_hash,
        AuditEvent.hash,
        AuditEvent.at,
        AuditEvent.actor,
        AuditEvent.ip,
        AuditEvent.action,
        AuditEvent.target,
        AuditEvent.detail,
    )
    query = select(*columns).where(AuditEvent.seq.is_not(None)).order_by(AuditEvent.seq)
    for row in session.execute(query.execution_options(yield_per=VERIFY_BATCH)):
        fields = chain_fields(
            row.seq, row.prev_hash or "", row.at, row.actor, row.ip, row.action, row.target, row.detail
        )
        yield Sealed(row.id, row.seq, row.prev_hash, row.hash, fields)


def current_head(session: Session) -> Head:
    head = head_of(session)
    return head.seq, head.hash


def verify(session: Session) -> ChainReport:
    head = current_head(session)
    pending = unsealed(session)
    return walk(stored(session), head, lambda: current_head(session), lambda: prune_anchors(session), pending)


def from_export(record: dict[str, Any]) -> Sealed | None:
    seq = record.get("seq")
    if not isinstance(seq, int) or isinstance(seq, bool):
        return None
    prev_hash = record.get("prev_hash")
    fields = chain_fields(
        seq,
        str(prev_hash or ""),
        datetime.fromisoformat(str(record["at"])),
        str(record["actor"]),
        record.get("ip"),
        str(record["action"]),
        str(record["target"]),
        record.get("detail"),
    )
    return Sealed(record.get("id"), seq, prev_hash, record.get("hash"), fields)


def verify_records(records: Iterable[dict[str, Any]]) -> ChainReport:
    loaded = list(records)
    rows = sorted((row for record in loaded if (row := from_export(record)) is not None), key=lambda row: row.seq)
    prunes = (anchor_of(record.get("detail")) for record in loaded if record.get("action") == PRUNE_ACTION)
    anchors = dict(anchor for anchor in prunes if anchor is not None)
    head = (rows[-1].seq, str(rows[-1].hash)) if rows else (0, GENESIS)
    return walk(rows, head, lambda: head, lambda: anchors, len(loaded) - len(rows))
