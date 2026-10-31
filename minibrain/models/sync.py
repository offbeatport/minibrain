from typing import Any

import httpx

from minibrain.ml.context import FinalError, JobSpec, report, run_child, write_result

REQUIRED = ("id", "repo", "variants")


def validate(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    entries = snapshot.get("entries")
    if not isinstance(entries, list) or not snapshot.get("snapshot"):
        raise FinalError("The catalogue file has no snapshot or entries")
    for entry in entries:
        missing = [key for key in REQUIRED if key not in entry]
        if missing:
            raise FinalError(f"Catalogue entry {entry.get('id', '?')} lacks {', '.join(missing)}")
    return entries


def main(spec: JobSpec) -> None:
    url = spec.raw.get("url")
    if not url:
        raise FinalError("No catalogue URL configured; the bundled catalogue stays in use")
    report(0.2, step=f"fetching {url}")
    with httpx.Client(timeout=httpx.Timeout(30.0), follow_redirects=True) as client:
        response = client.get(url)
    if response.status_code >= 400:
        raise FinalError(f"{url} answered {response.status_code}")
    snapshot = response.json()
    entries = validate(snapshot)
    write_result(spec, {"snapshot": snapshot["snapshot"], "entries": entries})
    report(1.0, step=f"{len(entries)} entries from snapshot {snapshot['snapshot']}")


if __name__ == "__main__":
    run_child(main)
