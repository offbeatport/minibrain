import contextlib
import logging
import signal
import sys
from types import FrameType

from watchfiles import PythonFilter, run_process


def main() -> None:
    stopping = False

    def interrupt(signum: int, frame: FrameType | None) -> None:
        nonlocal stopping
        if stopping:
            return
        stopping = True
        raise KeyboardInterrupt

    signal.signal(signal.SIGINT, interrupt)
    logging.getLogger("watchfiles").setLevel(logging.ERROR)
    with contextlib.suppress(KeyboardInterrupt):
        run_process("minibrain", target="minibrain serve", target_type="command", watch_filter=PythonFilter())


if __name__ == "__main__":
    main()
    sys.exit(0)
