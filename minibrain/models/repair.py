from typing import Any

import httpx

from minibrain.ml.context import JobSpec, report, run_child, write_result
from minibrain.models.download import TIMEOUT
from minibrain.models.sources import HUB, HubSource, StorageSource, location_url
from minibrain.models.transfer import (
    ChecksumError,
    Target,
    different_copy,
    hub_errors,
    hub_ready,
    install,
    storage_ready,
)

OFFLINE = "Offline: repairs need a connection to the model hub. Re-import the files from a folder or S3 path instead."


def from_hub(spec: JobSpec, files: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[str], str]:
    repo, revision = spec.raw["repo"], spec.raw["revision"]
    with httpx.Client(timeout=TIMEOUT, follow_redirects=True) as client, hub_errors(repo, revision):
        source = HubSource(repo, revision, files, client)
        ready = hub_ready(source, spec.raw["name"], bool(spec.raw.get("gated")), OFFLINE)
        recorded, repaired = install(source, files, Target.of(spec), "repairing", ChecksumError, ready)
    return recorded, repaired, source.describe()


def from_storage(spec: JobSpec, files: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[str], str]:
    source = StorageSource(location_url(spec.raw["source"], spec.raw["location"]))
    ready = storage_ready(source, spec.raw["name"])
    recorded, repaired = install(source, files, Target.of(spec), "re-importing", different_copy, ready)
    return recorded, repaired, source.describe()


def main(spec: JobSpec) -> None:
    files: list[dict[str, Any]] = spec.raw["files"]
    run = from_hub if spec.raw["source"] == HUB else from_storage
    recorded, repaired, origin = run(spec, files)
    Target.of(spec).finish({"source": origin, "files": recorded})
    write_result(spec, {"files": recorded, "repaired": repaired, "source": origin})
    report(1.0, step=f"replaced {len(repaired)} of {len(files)} files from {origin}", repaired=len(repaired))


if __name__ == "__main__":
    run_child(main)
