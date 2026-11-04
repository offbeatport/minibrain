import json
import logging
import os
import sys
from datetime import UTC, datetime
from typing import Any

from minibrain.policy import config_section
from minibrain.telemetry.call import current_call

FORMAT_ENV = "MINIBRAIN_LOG_FORMAT"
FORMATS = ("text", "json")
ACCESS_LOGGER = "uvicorn.access"
ACCESS_FIELDS = ("client", "method", "path", "http_version", "status")
UVICORN_LOGGERS = ("uvicorn", ACCESS_LOGGER)


class LogFormatError(Exception):
    pass


def log_format() -> str:
    chosen = os.environ.get(FORMAT_ENV, "").strip().lower()
    if not chosen:
        chosen = str(config_section("logging").get("format") or "text").strip().lower()
    if chosen not in FORMATS:
        raise LogFormatError(f"{FORMAT_ENV} and logging.format in minibrain.yaml are text or json, not {chosen}")
    return chosen


def timestamp(created: float) -> str:
    return datetime.fromtimestamp(created, UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, Any] = {
            "time": timestamp(record.created),
            "level": record.levelname.lower(),
            "logger": record.name,
            "message": record.getMessage(),
        }
        call = current_call()
        if call is not None:
            entry["request_id"] = call.request_id
            if call.response_id:
                entry["response_id"] = call.response_id
        if record.name == ACCESS_LOGGER and isinstance(record.args, tuple) and len(record.args) == len(ACCESS_FIELDS):
            entry |= dict(zip(ACCESS_FIELDS, record.args, strict=True))
        if record.exc_info:
            entry["exception"] = self.formatException(record.exc_info)
        return json.dumps(entry, ensure_ascii=False, default=str)


def json_handler() -> logging.Handler:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    return handler


def configure_logging() -> None:
    if log_format() != "json":
        return
    root = logging.getLogger()
    root.handlers = [json_handler()]
    root.setLevel(logging.INFO)
    for name in UVICORN_LOGGERS:
        logger = logging.getLogger(name)
        logger.handlers = [json_handler()]
        logger.propagate = False
