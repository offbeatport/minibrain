from typing import Any

import httpx

from minibrain.ml.context import FinalError, JobSpec, report, run_child, write_result
from minibrain.models import hub


def latest(client: httpx.Client, repo: str) -> dict[str, Any]:
    response = client.get(f"{hub.endpoint()}/api/models/{repo}", params={"blobs": "true"})
    response.raise_for_status()
    data = response.json()
    files = []
    for sibling in data.get("siblings", []):
        if hub.needed(sibling["rfilename"]):
            lfs = sibling.get("lfs") or {}
            size = sibling.get("size") or lfs.get("size") or 0
            files.append({"path": sibling["rfilename"], "size": size, "sha256": lfs.get("sha256")})
    files.sort(key=lambda item: item["path"])
    weights = sum(item["size"] for item in files if item["path"].endswith(".safetensors"))
    return {
        "revision": data["sha"],
        "files": files,
        "size_bytes": sum(item["size"] for item in files),
        "weights_bytes": weights,
        "downloads": int(data.get("downloads") or 0),
    }


def main(spec: JobSpec) -> None:
    if hub.offline():
        raise FinalError("Offline: the catalogue sync needs a connection; the bundled catalogue stays in use")
    variants: list[dict[str, str]] = spec.raw["variants"]
    result: dict[str, Any] = {"variants": {}, "popularity": {}}
    with httpx.Client(timeout=httpx.Timeout(30.0), headers=hub.headers(), follow_redirects=True) as client:
        for index, variant in enumerate(variants):
            found = latest(client, variant["repo"])
            result["variants"][variant["id"]] = found
            current = result["popularity"].get(variant["catalog_id"], 0)
            result["popularity"][variant["catalog_id"]] = max(current, found.pop("downloads"))
            report((index + 1) / len(variants), step=f"checked {variant['repo']}", revision=found["revision"][:12])
    write_result(spec, result)


if __name__ == "__main__":
    run_child(main)
