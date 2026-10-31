import logging
import threading
from datetime import timedelta

from sqlalchemy import delete
from sqlalchemy.orm import Session, sessionmaker

from minibrain.policy import load
from minibrain.registry.compute import forget_stale
from minibrain.registry.models import RequestLog, now

PURGE_SECONDS = 3600.0

log = logging.getLogger("minibrain")


def purge_request_logs(session: Session) -> int:
    days = int(load(session)["log_retention_days"])
    if days <= 0:
        return 0
    result = session.execute(delete(RequestLog).where(RequestLog.at < now() - timedelta(days=days)))
    session.commit()
    return int(getattr(result, "rowcount", 0) or 0)


def purge_forever(sessions: sessionmaker[Session], stop: threading.Event) -> None:
    while not stop.wait(PURGE_SECONDS):
        try:
            with sessions() as session:
                purge_request_logs(session)
                forget_stale(session)
                session.commit()
        except Exception:
            log.exception("request log purge failed")
