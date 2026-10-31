import subprocess
import sys
import threading
import time

RESTART_DELAYS = (1.0, 2.0, 5.0, 10.0, 30.0)
HEALTHY_SECONDS = 60.0


class Supervisor:
    def __init__(self, name: str, command: list[str], env: dict[str, str]) -> None:
        self.name = name
        self.command = command
        self.env = env
        self.stop = threading.Event()
        self.process: subprocess.Popen[bytes] | None = None
        self.restarts = 0
        self.thread = threading.Thread(target=self.loop, daemon=True)

    def start(self) -> None:
        self.thread.start()

    def loop(self) -> None:
        failures = 0
        while not self.stop.is_set():
            started = time.monotonic()
            self.process = subprocess.Popen(self.command, env=self.env)
            code = self.process.wait()
            if self.stop.is_set():
                return
            self.restarts += 1
            failures = 0 if time.monotonic() - started > HEALTHY_SECONDS else failures + 1
            delay = RESTART_DELAYS[min(failures, len(RESTART_DELAYS) - 1)]
            print(f"minibrain: {self.name} exited with {code}; restarting in {delay:.0f}s", file=sys.stderr, flush=True)
            self.stop.wait(delay)

    def shutdown(self) -> None:
        self.stop.set()
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                self.process.kill()
