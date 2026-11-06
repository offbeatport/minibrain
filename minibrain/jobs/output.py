import json
import re
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, Literal

Level = Literal["debug", "info", "warning", "error"]
Source = Literal["minibrain", "library", "system"]
LEVELS: tuple[Level, ...] = ("debug", "info", "warning", "error")
RESERVED = ("ts", "level", "event", "message")
EVENT = "event"
TEXT = "log"
STATE = "state"
SOURCES: dict[str, Source] = {EVENT: "minibrain", TEXT: "library", STATE: "system"}
TRACEBACK = "Traceback (most recent call last):"
CHAINS = ("During handling of the above exception", "The above exception was the direct cause")
STALE_SECONDS = 5.0

GLOG = re.compile(r"^([IWEF])\d{4} ")
GLOG_LEVELS: dict[str, Level] = {"I": "info", "W": "warning", "E": "error", "F": "error"}
ERROR_LINE = re.compile(r"^\[?(?:ERROR|CRITICAL|FATAL)\b|^[\w.]*(?:Error|Exception): |\b(?:ERROR|CRITICAL|FATAL)[:\]]")
WARNING_LINE = re.compile(r"\b\w*Warning: |^\[?(?:WARNING|WARN)\b|\b(?:WARNING|WARN)[:\]]")
DEBUG_LINE = re.compile(r"^\[?DEBUG\b")

Clock = Callable[[], datetime]


def utc_now() -> datetime:
    return datetime.now(UTC)


def stamp(moment: datetime) -> str:
    return moment.isoformat(timespec="milliseconds")


def structured(line: str) -> dict[str, Any] | None:
    if not line.startswith("{"):
        return None
    try:
        value = json.loads(line)
    except json.JSONDecodeError:
        return None
    if not isinstance(value, dict) or not isinstance(value.get(EVENT), str) or value.get("level") not in LEVELS:
        return None
    return value


def guess_level(line: str) -> Level:
    text = line.strip()
    glog = GLOG.match(text)
    if glog is not None:
        return GLOG_LEVELS[glog.group(1)]
    if ERROR_LINE.search(text):
        return "error"
    if WARNING_LINE.search(text):
        return "warning"
    return "debug" if DEBUG_LINE.match(text) else "info"


def event_record(entry: dict[str, Any], moment: datetime) -> dict[str, Any]:
    fields = {key: value for key, value in entry.items() if key not in RESERVED}
    ts = entry.get("ts")
    return {
        "kind": EVENT,
        "level": entry["level"],
        "name": entry[EVENT],
        "message": str(entry.get("message") or ""),
        "data": fields or None,
        "at": ts if isinstance(ts, str) else stamp(moment),
    }


def text_record(line: str, moment: datetime) -> dict[str, Any]:
    return {"kind": TEXT, "level": guess_level(line), "name": None, "message": line, "data": None, "at": stamp(moment)}


def indented(line: str) -> bool:
    return line[:1] in (" ", "\t")


class Traceback:
    def __init__(self, first: str, moment: datetime) -> None:
        self.lines = [first]
        self.blanks: list[str] = []
        self.started = moment
        self.closing = False

    def takes(self, line: str) -> bool:
        if not line.strip():
            self.blanks.append(line)
            return True
        if line.startswith(TRACEBACK) or line.startswith(CHAINS) or indented(line):
            self.lines += [*self.blanks, line]
            self.blanks = []
            self.closing = self.closing and not line.startswith(TRACEBACK) and indented(line)
            return True
        if self.closing:
            return False
        self.lines.append(line)
        self.closing = True
        return True

    def record(self) -> dict[str, Any]:
        message = next(line for line in reversed(self.lines) if line.strip() and not indented(line))
        return {
            "kind": TEXT,
            "level": "error",
            "name": None,
            "message": message,
            "data": {"traceback": "\n".join(self.lines)},
            "at": stamp(self.started),
        }


class OutputParser:
    def __init__(self, clock: Clock = utc_now) -> None:
        self.clock = clock
        self.open: Traceback | None = None

    def feed(self, line: str) -> list[dict[str, Any]]:
        moment = self.clock()
        records: list[dict[str, Any]] = []
        if self.open is not None:
            if self.open.takes(line):
                return records
            records.append(self.open.record())
            self.open = None
        if line.startswith(TRACEBACK):
            self.open = Traceback(line, moment)
            return records
        if not line.strip():
            return records
        entry = structured(line)
        records.append(event_record(entry, moment) if entry is not None else text_record(line, moment))
        return records

    def flush(self, final: bool = False) -> list[dict[str, Any]]:
        group = self.open
        if group is None:
            return []
        stale = (self.clock() - group.started).total_seconds() >= STALE_SECONDS
        if not (final or group.closing or stale):
            return []
        self.open = None
        return [group.record()]


def level_of(value: str) -> Level:
    found: Level = "info"
    for level in LEVELS:
        if level == value:
            found = level
    return found
