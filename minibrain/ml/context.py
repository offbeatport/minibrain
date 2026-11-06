import json
import sys
import traceback
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from minibrain.base_models import BaseModelSpec, base_model
from minibrain.jobs.output import stamp, utc_now

FINAL_EXIT = 2


class FinalError(Exception):
    def __init__(self, message: str, code: str | None = None) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class JobSpec:
    raw: dict[str, Any]
    result_path: Path

    def path(self, key: str) -> Path:
        return Path(self.raw[key])

    def optional_path(self, key: str) -> Path | None:
        value = self.raw.get(key)
        return Path(value) if value else None

    @property
    def base(self) -> BaseModelSpec:
        if "base_spec" in self.raw:
            return BaseModelSpec.from_dict(self.raw["base_spec"])
        return base_model(self.raw["base_model"])


def load_spec(path: Path) -> JobSpec:
    raw = json.loads(path.read_text())
    return JobSpec(raw=raw, result_path=Path(raw["result"]))


def emit(event: str, message: str = "", level: str = "info", progress: float | None = None, **fields: Any) -> None:
    entry: dict[str, Any] = {"ts": stamp(utc_now()), "level": level, "event": event, "message": message}
    if progress is not None:
        entry["progress"] = round(max(0.0, min(progress, 1.0)), 4)
    print(json.dumps(entry | fields, default=str), flush=True)


def fail_with(message: str, retryable: bool, code: str | None = None) -> None:
    emit("job.error", message, "error", retryable=retryable, code=code)


def write_result(spec: JobSpec, result: dict[str, Any]) -> None:
    spec.result_path.write_text(json.dumps(result))


def run_child(main: Callable[[JobSpec], None], final_errors: tuple[type[Exception], ...] = ()) -> None:
    spec = load_spec(Path(sys.argv[1]))
    try:
        main(spec)
    except (FinalError, *final_errors) as error:
        fail_with(str(error), False, getattr(error, "code", None))
        sys.exit(FINAL_EXIT)
    except Exception as error:
        traceback.print_exc()
        sys.stderr.flush()
        fail_with(f"{type(error).__name__}: {error}", True)
        sys.exit(1)
