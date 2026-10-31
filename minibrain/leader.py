import logging
import threading
from typing import Protocol

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection
from sqlalchemy.pool import NullPool

LOCK_KEY = 0x6D696E69627261
KEEPALIVE = {"keepalives": 1, "keepalives_idle": 10, "keepalives_interval": 5, "keepalives_count": 3}

log = logging.getLogger("minibrain.leader")


class Leader(Protocol):
    def held(self) -> bool: ...

    def describe(self) -> str: ...


class SingleLeader:
    def held(self) -> bool:
        return True

    def describe(self) -> str:
        return "single"

    def release(self) -> None:
        return None


class AdvisoryLeader:
    def __init__(self, url: str, key: int = LOCK_KEY) -> None:
        self.engine = create_engine(url, poolclass=NullPool, connect_args=KEEPALIVE)
        self.key = key
        self.connection: Connection | None = None
        self.leading = False
        self.lock = threading.Lock()

    def held(self) -> bool:
        with self.lock:
            try:
                if self.connection is None:
                    self.connection = self.engine.connect().execution_options(isolation_level="AUTOCOMMIT")
                if self.leading:
                    self.connection.execute(text("select 1"))
                    return True
                acquired = self.connection.execute(text("select pg_try_advisory_lock(:key)"), {"key": self.key})
                self.leading = bool(acquired.scalar())
                if self.leading:
                    log.info("this main now runs the background loops")
                return self.leading
            except Exception:
                if self.leading:
                    log.warning("lost the leader lock; another main takes over the background loops")
                self.drop()
                return False

    def describe(self) -> str:
        return "leader" if self.leading else "standby"

    def drop(self) -> None:
        self.leading = False
        if self.connection is not None:
            try:
                self.connection.close()
            except Exception:
                log.debug("leader connection was already gone")
        self.connection = None

    def release(self) -> None:
        with self.lock:
            if self.leading and self.connection is not None:
                try:
                    self.connection.execute(text("select pg_advisory_unlock(:key)"), {"key": self.key})
                except Exception:
                    log.debug("leader connection was already gone")
            self.drop()


def leader_for(url: str) -> SingleLeader | AdvisoryLeader:
    return AdvisoryLeader(url) if url.startswith("postgresql") else SingleLeader()
