from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.orm import Session

from minibrain.registry.settings_store import read, write

KEY = "compute.prices"
DEVICE_TIME = "device_time"
DEFAULT_CURRENCY = "USD"
PER_REQUESTS = 1000
SECONDS_PER_HOUR = 3600


@dataclass(frozen=True)
class DevicePrices:
    currency: str = DEFAULT_CURRENCY
    hourly: dict[str, float] = field(default_factory=dict)

    def hourly_for(self, pool: str | None) -> float | None:
        price = self.hourly.get(pool) if pool else None
        return price if price else None

    def as_dict(self) -> dict[str, Any]:
        return {"currency": self.currency, "hourly": dict(sorted(self.hourly.items()))}


@dataclass(frozen=True)
class EvalCost:
    source: str
    pool: str | None
    device: str | None
    device_name: str | None
    batch_size: int | None
    requests: int
    device_seconds_per_1k: float
    prompt_tokens: float | None
    completion_tokens: float | None
    hourly_price: float | None
    currency: str | None
    per_1k: float | None


def load_prices(session: Session) -> DevicePrices:
    stored = read(session, KEY, {}) or {}
    hourly = {str(pool): float(price) for pool, price in (stored.get("hourly") or {}).items() if price}
    return DevicePrices(currency=str(stored.get("currency") or DEFAULT_CURRENCY), hourly=hourly)


def save_prices(session: Session, currency: str | None, hourly: dict[str, float] | None) -> DevicePrices:
    current = load_prices(session)
    merged = dict(current.hourly)
    for pool, price in (hourly or {}).items():
        if price > 0:
            merged[pool] = float(price)
        else:
            merged.pop(pool, None)
    saved = DevicePrices(currency=currency or current.currency, hourly=merged)
    write(session, KEY, saved.as_dict())
    return saved


def optional_float(value: Any) -> float | None:
    return None if value is None else float(value)


def eval_cost(metrics: dict[str, Any] | None, prices: DevicePrices) -> EvalCost | None:
    measured = (metrics or {}).get("cost") or {}
    requests = int(measured.get("requests") or 0)
    if measured.get("source") != DEVICE_TIME or requests <= 0:
        return None
    pool = measured.get("pool")
    per_1k = float(measured.get("device_seconds") or 0.0) / requests * PER_REQUESTS
    hourly = prices.hourly_for(pool)
    return EvalCost(
        source=DEVICE_TIME,
        pool=pool,
        device=measured.get("device"),
        device_name=measured.get("device_name"),
        batch_size=measured.get("batch_size"),
        requests=requests,
        device_seconds_per_1k=per_1k,
        prompt_tokens=optional_float(measured.get("prompt_tokens")),
        completion_tokens=optional_float(measured.get("completion_tokens")),
        hourly_price=hourly,
        currency=prices.currency if hourly else None,
        per_1k=per_1k / SECONDS_PER_HOUR * hourly if hourly else None,
    )
