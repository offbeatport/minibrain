import json
from typing import Any

import httpx

from minibrain.ml.context import FinalError, JobSpec, report, run_child, write_result
from minibrain.models import hub
from minibrain.models.files import Progress, check, valid, write_stream
from minibrain.models.sources import HubSource

TIMEOUT = httpx.Timeout(30.0, read=300.0)


class ChecksumError(Exception):
    pass


def gated_message(spec: JobSpec) -> str:
    return (
        f"{spec.raw['name']} is gated. Accept its licence at {hub.endpoint()}/{spec.raw['repo']} "
        "and set HF_TOKEN on the minibrain server, then retry."
    )


def main(spec: JobSpec) -> None:
    out = spec.path("out")
    out.mkdir(parents=True, exist_ok=True)
    files: list[dict[str, Any]] = spec.raw["files"]
    progress = Progress(sum(entry["size"] for entry in files), "downloading")
    report(0.0, step="checking existing files")
    with httpx.Client(timeout=TIMEOUT, follow_redirects=True) as client:
        source = HubSource(spec.raw["repo"], spec.raw["revision"], files, client)
        for entry in files:
            target = out / entry["path"]
            if valid(target, entry):
                progress.add(entry["size"], entry["path"])
                continue
            if source.cached(entry["path"]) is None:
                if hub.offline():
                    raise FinalError("Offline: downloads need a connection. Import the model files instead.")
                if spec.raw.get("gated") and hub.token() is None:
                    raise FinalError(gated_message(spec))
            try:
                digest = write_stream(source.chunks(entry["path"]), target, progress, entry["path"])
            except PermissionError as error:
                raise FinalError(gated_message(spec)) from error
            check(entry, target, digest, ChecksumError)
    manifest = {"repo": spec.raw["repo"], "revision": spec.raw["revision"], "files": files}
    (out / "minibrain-model.json").write_text(json.dumps(manifest, indent=1))
    write_result(spec, {"files": files, "size_bytes": progress.total, "revision": spec.raw["revision"]})
    report(1.0, step="validated", files=len(files))


if __name__ == "__main__":
    run_child(main)
