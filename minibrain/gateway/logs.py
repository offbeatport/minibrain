import logging
import threading
from collections.abc import Callable
from dataclasses import asdict, dataclass, replace
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from minibrain.registry.models import ApiKey, Model, RequestLog

FLUSH_SECONDS = 2.0
MAX_BUFFERED = 10_000

log = logging.getLogger("minibrain.gateway")


@dataclass(frozen=True)
class LogEntry:
    at: datetime
    key_id: int | None
    model_id: int | None
    model: str
    version: int | None
    status: int
    latency_ms: float
    contract: int | None = None
    prompt_tokens: int = 0
    completion_tokens: int = 0
    response_id: str | None = None
    input: str | None = None
    output: str | None = None
    finish_reason: str | None = None

    def as_json(self) -> dict:
        return asdict(self) | {"at": self.at.isoformat()}


Sink = Callable[[list[LogEntry]], None]


class LogBuffer:
    def __init__(self, sink: Sink) -> None:
        self.sink = sink
        self.entries: list[LogEntry] = []
        self.lock = threading.Lock()
        self.dropped = 0

    def add(self, entry: LogEntry) -> None:
        with self.lock:
            if len(self.entries) >= MAX_BUFFERED:
                self.entries.pop(0)
                self.dropped += 1
            self.entries.append(entry)

    def flush(self) -> int:
        with self.lock:
            batch, self.entries = self.entries, []
        if not batch:
            return 0
        try:
            self.sink(batch)
        except Exception:
            with self.lock:
                self.entries = (batch + self.entries)[-MAX_BUFFERED:]
            raise
        return len(batch)

    def flush_forever(self, stop: threading.Event) -> None:
        while not stop.wait(FLUSH_SECONDS):
            try:
                self.flush()
            except Exception:
                log.warning("request logs kept in memory; main unreachable")
        self.flush()


def existing(session: Session, batch: list[LogEntry]) -> Callable[[LogEntry], LogEntry]:
    def keep(entry: LogEntry) -> LogEntry:
        key_id = entry.key_id if entry.key_id in keys else None
        model_id = entry.model_id if entry.model_id in models else None
        return replace(entry, key_id=key_id, model_id=model_id)

    keys = set(session.scalars(select(ApiKey.id).where(ApiKey.id.in_({e.key_id for e in batch if e.key_id}))))
    wanted = {entry.model_id for entry in batch if entry.model_id}
    models = set(session.scalars(select(Model.id).where(Model.id.in_(wanted))))
    return keep


def database_sink(sessions: sessionmaker[Session]) -> Sink:
    def write(batch: list[LogEntry]) -> None:
        with sessions() as session:
            entries = list(map(existing(session, batch), batch))
            session.add_all(RequestLog(**asdict(entry)) for entry in entries)
            last_used: dict[int, datetime] = {}
            for entry in entries:
                if entry.key_id is not None and entry.status < 400:
                    last_used[entry.key_id] = max(entry.at, last_used.get(entry.key_id, entry.at))
            for key_id, at in last_used.items():
                key = session.get(ApiKey, key_id)
                if key is not None:
                    key.last_used_at = at
            session.commit()

    return write
