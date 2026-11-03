import logging
from collections import deque

LIMIT = 1000
CAPTURED = ("minibrain", "uvicorn.error")


class RecentLogs(logging.Handler):
    def __init__(self, limit: int = LIMIT) -> None:
        super().__init__()
        self.lines: deque[str] = deque(maxlen=limit)
        self.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self.lines.append(self.format(record))
        except Exception:
            self.handleError(record)

    def text(self) -> str:
        return "\n".join(self.lines) + "\n" if self.lines else ""


RECENT = RecentLogs()


def capture() -> None:
    for name in CAPTURED:
        logger = logging.getLogger(name)
        if RECENT not in logger.handlers:
            logger.addHandler(RECENT)
