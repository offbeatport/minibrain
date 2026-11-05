import hashlib
import json
import sys
from pathlib import Path
from typing import Any

import httpx

from minibrain.encryption.envelope import EnvelopeError
from minibrain.ml.context import JobSpec, report, run_child, write_result
from minibrain.models.copies import BUCKET, CopyError, bucket_chunks, bucket_client
from minibrain.models.files import Progress, file_chunks
from minibrain.models.health import CORRUPT, MISSING, WRONG_SIZE


def digest_of(path: Path, progress: Progress, name: str) -> str:
    digest = hashlib.sha256()
    for chunk in file_chunks(path):
        digest.update(chunk)
        progress.add(len(chunk), name)
    return digest.hexdigest()


def check(folder: Path, entry: dict[str, Any], progress: Progress) -> dict[str, Any]:
    target = folder / entry["path"]
    found = {"path": entry["path"], "size": entry["size"], "sha256": entry.get("sha256")}
    if not target.is_file():
        progress.add(int(entry["size"]), entry["path"])
        return found | {"status": MISSING}
    if target.stat().st_size != entry["size"]:
        progress.add(int(entry["size"]), entry["path"])
        return found | {"status": WRONG_SIZE}
    digest = digest_of(target, progress, entry["path"])
    if entry.get("sha256") and digest != entry["sha256"]:
        return found | {"status": CORRUPT, "actual": digest}
    return found | {"sha256": digest, "status": "ok"}


def check_object(http: httpx.Client, entry: dict[str, Any], progress: Progress) -> dict[str, Any]:
    found = {"path": entry["path"], "size": entry["size"], "sha256": entry.get("sha256")}
    digest = hashlib.sha256()
    size = 0
    try:
        with bucket_chunks(http, entry) as chunks:
            for chunk in chunks:
                digest.update(chunk)
                size += len(chunk)
                progress.add(len(chunk), entry["path"])
    except CopyError:
        return found | {"status": MISSING}
    except EnvelopeError:
        return found | {"status": CORRUPT, "actual": None}
    if size != entry["size"] or (entry.get("sha256") and digest.hexdigest() != entry["sha256"]):
        return found | {"status": CORRUPT, "actual": digest.hexdigest()}
    return found | {"sha256": digest.hexdigest(), "status": "ok"}


def check_bucket(files: list[dict[str, Any]], progress: Progress) -> list[dict[str, Any]]:
    signed = {str(entry["path"]): entry for entry in json.loads(sys.stdin.read() or "{}").get("files", [])}
    with bucket_client() as http:
        return [
            check_object(http, signed[entry["path"]], progress)
            if entry["path"] in signed
            else {"path": entry["path"], "size": entry["size"], "sha256": entry.get("sha256"), "status": MISSING}
            for entry in files
        ]


def main(spec: JobSpec) -> None:
    folder = spec.path("folder")
    files: list[dict[str, Any]] = spec.raw["files"]
    progress = Progress(sum(int(entry["size"]) for entry in files), "checking")
    if spec.raw.get("store") == BUCKET:
        report(0.0, step=f"checking {len(files)} files in the bucket")
        checked = check_bucket(files, progress)
    else:
        report(0.0, step=f"checking {len(files)} files in {folder}")
        checked = [check(folder, entry, progress) for entry in files]
    bad = [entry for entry in checked if entry["status"] != "ok"]
    for entry in bad:
        report(step=f"{entry['path']}: {entry['status'].replace('_', ' ')}")
    write_result(spec, {"files": checked})
    report(1.0, step=f"{len(checked) - len(bad)} of {len(checked)} files match", bad=len(bad))


if __name__ == "__main__":
    run_child(main)
