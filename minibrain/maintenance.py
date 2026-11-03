import logging
import threading
from datetime import timedelta

from sqlalchemy import delete
from sqlalchemy.orm import Session, sessionmaker

from minibrain.data.snapshots import cleanup
from minibrain.leader import Leader
from minibrain.policy import load
from minibrain.registry.compute import forget_stale
from minibrain.registry.models import SYSTEM_ACTOR, AuditEvent, RequestLog, now
from minibrain.settings import Settings

PURGE_SECONDS = 3600.0

log = logging.getLogger("minibrain")


def purge_request_logs(session: Session) -> int:
    days = int(load(session)["log_retention_days"])
    if days <= 0:
        return 0
    result = session.execute(delete(RequestLog).where(RequestLog.at < now() - timedelta(days=days)))
    session.commit()
    return int(getattr(result, "rowcount", 0) or 0)


def purge_audit_events(session: Session) -> int:
    days = int(load(session)["audit_retention_days"])
    if days <= 0:
        return 0
    cutoff = now() - timedelta(days=days)
    result = session.execute(delete(AuditEvent).where(AuditEvent.at < cutoff))
    deleted = int(getattr(result, "rowcount", 0) or 0)
    if deleted:
        detail = {"deleted": deleted, "older_than": cutoff.isoformat(), "days": days}
        session.add(AuditEvent(actor=SYSTEM_ACTOR, action="audit.prune", target="audit_events", detail=detail))
    session.commit()
    return deleted


def purge_forever(sessions: sessionmaker[Session], settings: Settings, stop: threading.Event, leader: Leader) -> None:
    while not stop.wait(PURGE_SECONDS):
        try:
            if not leader.held():
                continue
            with sessions() as session:
                purge_request_logs(session)
                purge_audit_events(session)
                forget_stale(session)
                cleanup(session, settings)
                session.commit()
        except Exception:
            log.exception("request log purge failed")
