import logging
import sys
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


class Console(logging.StreamHandler):
    def __init__(self) -> None:
        super().__init__(sys.stderr)
        self.setLevel(logging.WARNING)
        self.setFormatter(logging.Formatter("%(levelname)s: %(message)s"))

    def emit(self, record: logging.LogRecord) -> None:
        if not logging.getLogger().handlers:
            self.stream = sys.stderr
            super().emit(record)


RECENT = RecentLogs()
CONSOLE = Console()


def capture() -> None:
    for name in CAPTURED:
        logger = logging.getLogger(name)
        if RECENT not in logger.handlers:
            logger.addHandler(RECENT)
    owned = logging.getLogger(CAPTURED[0])
    if CONSOLE not in owned.handlers:
        owned.addHandler(CONSOLE)
