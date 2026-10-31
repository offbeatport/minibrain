import json
import sys
import traceback
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from minibrain.base_models import BaseModelSpec, base_model

FINAL_EXIT = 2


class FinalError(Exception):
    pass


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


def report(progress: float | None = None, **details: Any) -> None:
    entry = details if progress is None else {"progress": round(max(0.0, min(progress, 1.0)), 4)} | details
    print(json.dumps(entry), flush=True)


def write_result(spec: JobSpec, result: dict[str, Any]) -> None:
    spec.result_path.write_text(json.dumps(result))


def run_child(main: Callable[[JobSpec], None], final_errors: tuple[type[Exception], ...] = ()) -> None:
    spec = load_spec(Path(sys.argv[1]))
    try:
        main(spec)
    except (FinalError, *final_errors) as error:
        print(json.dumps({"error": str(error), "retryable": False}), flush=True)
        sys.exit(FINAL_EXIT)
    except Exception as error:
        traceback.print_exc()
        print(json.dumps({"error": f"{type(error).__name__}: {error}", "retryable": True}), flush=True)
        sys.exit(1)
