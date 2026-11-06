from collections.abc import Iterable
from dataclasses import asdict, dataclass, fields, replace
from typing import Any

MAX_STOPS = 4
GREEDY = 0.0
PARAMETERS = (
    "temperature",
    "top_p",
    "top_k",
    "min_p",
    "presence_penalty",
    "frequency_penalty",
    "repetition_penalty",
    "seed",
    "stop",
)


class UnsupportedParameterError(Exception):
    def __init__(self, param: str, message: str) -> None:
        super().__init__(message)
        self.param = param
        self.message = message


@dataclass(frozen=True)
class Sampling:
    temperature: float | None = None
    top_p: float | None = None
    top_k: int | None = None
    min_p: float | None = None
    presence_penalty: float | None = None
    frequency_penalty: float | None = None
    repetition_penalty: float | None = None
    seed: int | None = None
    stop: tuple[str, ...] = ()

    def given(self) -> dict[str, Any]:
        found = {key: value for key, value in asdict(self).items() if value is not None and key != "stop"}
        return found | ({"stop": list(self.stop)} if self.stop else {})

    def names(self) -> list[str]:
        return list(self.given())

    @property
    def greedy(self) -> bool:
        return self.temperature is not None and self.temperature <= GREEDY

    def or_greedy(self) -> "Sampling":
        return self if self.temperature is not None else replace(self, temperature=GREEDY)

    def over(self, defaults: "Sampling") -> "Sampling":
        merged = {field.name: getattr(self, field.name) for field in fields(self)}
        for field in fields(self):
            if merged[field.name] in (None, ()):
                merged[field.name] = getattr(defaults, field.name)
        return Sampling(**merged)

    def refuse_beyond(self, supported: Iterable[str], engine: str) -> None:
        allowed = set(supported)
        for name in self.names():
            if name not in allowed:
                raise UnsupportedParameterError(name, f"the {engine} engine cannot honour {name}; leave it unset")

    @staticmethod
    def from_dict(data: dict[str, Any] | None) -> "Sampling":
        found = dict(data or {})
        stop = found.pop("stop", None) or ()
        known = {key: found[key] for key in PARAMETERS if key in found and key != "stop"}
        return Sampling(**known, stop=tuple(stop))


GREEDY_SAMPLING = Sampling(temperature=GREEDY)


def stopped_at(text: str, stops: tuple[str, ...]) -> int | None:
    found = [index for index in (text.find(stop) for stop in stops if stop) if index >= 0]
    return min(found) if found else None


def held_back(text: str, stops: tuple[str, ...]) -> int:
    longest = 0
    for stop in stops:
        for size in range(min(len(stop) - 1, len(text)), 0, -1):
            if stop.startswith(text[-size:]):
                longest = max(longest, size)
                break
    return longest


@dataclass
class StopCutter:
    stops: tuple[str, ...]
    text: str = ""
    sent: int = 0
    stopped: bool = False

    def feed(self, piece: str) -> str:
        if self.stopped:
            return ""
        self.text += piece
        cut = stopped_at(self.text, self.stops)
        if cut is not None:
            self.stopped = True
            return self.release(cut)
        return self.release(len(self.text) - held_back(self.text, self.stops))

    def release(self, end: int) -> str:
        found = self.text[self.sent : max(end, self.sent)]
        self.sent = max(end, self.sent)
        return found

    def finish(self) -> str:
        return "" if self.stopped else self.release(len(self.text))
