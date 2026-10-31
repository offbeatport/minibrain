import hashlib
import json
import threading
import time
from collections import OrderedDict
from collections.abc import Callable

BUSY_AT = 4
DOWN_SECONDS = 10.0
PREFIX_CHARS = 512
STICKY_LIMIT = 10_000
TIER = {"ready": 0, "loading": 1, "down": 2}

Replica = dict[str, str]


def spread(key: str, url: str) -> bytes:
    return hashlib.sha256(f"{key}|{url}".encode(), usedforsecurity=False).digest()[:8]


def sticky_key(base: str, adapter: str | None, messages: list[dict[str, str]]) -> str:
    if adapter is not None:
        return f"{base}|adapter:{adapter}"
    history = messages[:-1] or messages[:1]
    prefix = json.dumps([(item.get("role"), (item.get("content") or "")[:PREFIX_CHARS]) for item in history])
    return f"{base}|prefix:{hashlib.sha256(prefix.encode(), usedforsecurity=False).hexdigest()[:16]}"


class Balancer:
    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self.clock = clock
        self.lock = threading.Lock()
        self.in_flight: dict[str, int] = {}
        self.sticky: OrderedDict[str, str] = OrderedDict()
        self.probed: dict[str, str] = {}
        self.down_until: dict[str, float] = {}

    def state(self, replica: Replica) -> str:
        url = replica["url"]
        if self.down_until.get(url, 0.0) > self.clock():
            return "down"
        return self.probed.get(url) or replica.get("state") or "ready"

    def busy(self, url: str) -> int:
        return self.in_flight.get(url, 0)

    def choose(self, replicas: list[Replica], key: str, exclude: set[str] | None = None) -> str | None:
        with self.lock:
            candidates = [replica for replica in replicas if replica["url"] not in (exclude or set())]
            if not candidates:
                return None
            best = min(TIER.get(self.state(replica), 2) for replica in candidates)
            urls = [replica["url"] for replica in candidates if TIER.get(self.state(replica), 2) == best]
            least = min(urls, key=lambda url: (self.busy(url), spread(key, url)))
            bound = self.sticky.get(key)
            if bound in urls:
                overflow = self.busy(bound) >= BUSY_AT and self.busy(least) < self.busy(bound)
                chosen = least if overflow else bound
            else:
                chosen = self.bind(key, least)
            self.in_flight[chosen] = self.busy(chosen) + 1
            return chosen

    def bind(self, key: str, url: str) -> str:
        self.sticky[key] = url
        self.sticky.move_to_end(key)
        while len(self.sticky) > STICKY_LIMIT:
            self.sticky.popitem(last=False)
        return url

    def rebind(self, key: str, url: str) -> None:
        with self.lock:
            self.bind(key, url)

    def release(self, url: str) -> None:
        with self.lock:
            self.in_flight[url] = max(self.busy(url) - 1, 0)

    def mark(self, url: str, state: str) -> None:
        with self.lock:
            if state == "down":
                self.down_until[url] = self.clock() + DOWN_SECONDS
                return
            self.down_until.pop(url, None)
            self.probed[url] = state
