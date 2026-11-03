from typing import Any

import httpx

from minibrain.ml.context import JobSpec, report, run_child, write_result
from minibrain.models.sources import HubSource
from minibrain.models.transfer import ChecksumError, hub_errors, hub_ready, install, write_manifest

TIMEOUT = httpx.Timeout(30.0, read=300.0)
OFFLINE = "Offline: downloads need a connection. Import the model files instead."


def main(spec: JobSpec) -> None:
    out = spec.path("out")
    files: list[dict[str, Any]] = spec.raw["files"]
    repo, revision = spec.raw["repo"], spec.raw["revision"]
    with httpx.Client(timeout=TIMEOUT, follow_redirects=True) as client, hub_errors(repo, revision):
        source = HubSource(repo, revision, files, client)
        ready = hub_ready(source, spec.raw["name"], bool(spec.raw.get("gated")), OFFLINE)
        recorded, _ = install(source, files, out, "downloading", ChecksumError, ready)
    write_manifest(out, {"repo": repo, "revision": revision, "files": recorded})
    size = sum(int(entry["size"]) for entry in files)
    write_result(spec, {"files": recorded, "size_bytes": size, "revision": revision})
    report(1.0, step="validated", files=len(files))


if __name__ == "__main__":
    run_child(main)
