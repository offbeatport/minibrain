import random
from collections.abc import Callable
from dataclasses import dataclass
from datetime import timedelta

from minibrain.registry.models import JobKind

LEASE = timedelta(seconds=60)
BASE_DELAY_SECONDS = 30
MAX_DELAY_SECONDS = 600


@dataclass(frozen=True)
class KindPolicy:
    max_attempts: int
    max_runtime: timedelta
    needs_gpu: bool


POLICIES: dict[str, KindPolicy] = {
    JobKind.PREPARE: KindPolicy(max_attempts=3, max_runtime=timedelta(hours=1), needs_gpu=False),
    JobKind.TRAIN: KindPolicy(max_attempts=3, max_runtime=timedelta(hours=24), needs_gpu=True),
    JobKind.EVAL: KindPolicy(max_attempts=3, max_runtime=timedelta(hours=4), needs_gpu=True),
}


def policy(kind: str) -> KindPolicy:
    return POLICIES[kind]


def backoff(attempt: int, jitter: Callable[[], float] = random.random) -> timedelta:
    ceiling = min(MAX_DELAY_SECONDS, BASE_DELAY_SECONDS * 2 ** max(attempt - 1, 0))
    return timedelta(seconds=ceiling * (0.5 + jitter() / 2))
