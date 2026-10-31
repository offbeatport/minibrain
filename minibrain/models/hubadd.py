import re
from typing import Any

import httpx

from minibrain.models import hub
from minibrain.models.rules import LICENCE_OVERRIDES, LICENCES, SUPPORTED_ARCHITECTURES, needed, tier

REPO = re.compile(r"^[A-Za-z0-9][\w.-]*/[\w.-]+$")
TIMEOUT = httpx.Timeout(20.0)


class HubAddError(Exception):
    pass


def parse_repo(text: str) -> str:
    value = re.sub(r"^https?://[^/]+/", "", text.strip()).split("?", 1)[0].split("#", 1)[0].strip("/")
    parts = [part for part in value.split("/") if part]
    if parts and parts[0] == "models":
        parts = parts[1:]
    repo = "/".join(parts[:2])
    if not REPO.match(repo):
        raise HubAddError("Paste a Hugging Face model link or an id like Qwen/Qwen3-8B")
    return repo


def entry_id(repo: str) -> str:
    return "hf-" + re.sub(r"[^a-z0-9.]+", "-", repo.lower()).strip("-")


def fetch(client: httpx.Client, repo: str) -> tuple[dict[str, Any], dict[str, Any]]:
    response = client.get(f"{hub.endpoint()}/api/models/{repo}", params={"blobs": "true"})
    if response.status_code == 404:
        raise HubAddError(f"{repo} was not found on {hub.endpoint()}")
    if response.status_code in (401, 403):
        raise HubAddError(f"{repo} needs access: accept it on {hub.endpoint()}/{repo} and set HF_TOKEN")
    response.raise_for_status()
    info = response.json()
    config = dict(info.get("config") or {})
    resolved = client.get(f"{hub.endpoint()}/{repo}/resolve/{info['sha']}/config.json")
    if resolved.status_code == 200:
        config |= resolved.json()
    return info, config


def licence_of(repo: str, info: dict[str, Any]) -> tuple[str, str, str, str]:
    card = info.get("cardData") or {}
    found = card.get("license")
    if found == "other":
        found = card.get("license_name") or found
    found = LICENCE_OVERRIDES.get(repo) or found or "unknown"
    if found in LICENCES:
        name, summary, url = LICENCES[found]
        return found, name, summary, url
    return (
        found,
        f"Licence: {found}",
        "Not on minibrain's reviewed list; read it on the model page before using the model.",
        f"{hub.endpoint()}/{repo}",
    )


def describe(repo: str, info: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    files = []
    for sibling in info.get("siblings", []):
        if needed(sibling["rfilename"]):
            lfs = sibling.get("lfs") or {}
            files.append(
                {
                    "path": sibling["rfilename"],
                    "size": sibling.get("size") or lfs.get("size") or 0,
                    "sha256": lfs.get("sha256"),
                }
            )
    files.sort(key=lambda item: item["path"])
    weights = sum(item["size"] for item in files if item["path"].endswith(".safetensors"))
    if weights == 0:
        raise HubAddError(f"{repo} has no safetensors weights; minibrain only loads safetensors")
    architecture = str(config.get("model_type", ""))
    params = ((info.get("safetensors") or {}).get("total") or weights / 2) / 1e9
    moe = "num_experts" in config or "num_local_experts" in config or "moe" in architecture
    size_tier = tier(params, moe and params > 15, weights / 1e9)
    licence, name, summary, url = licence_of(repo, info)
    identifier = entry_id(repo)
    requires = {"gpus": "multi", "note": "Needs several datacenter GPUs."} if size_tier == "XL" else {}
    return {
        "id": identifier,
        "name": repo.split("/", 1)[1].replace("-", " ").replace("_", " "),
        "description": f"Added from {hub.endpoint()}: {repo}, {params:.1f}B parameters.",
        "provider": repo.split("/", 1)[0],
        "repo": repo,
        "capabilities": ["Chat"],
        "license": licence,
        "license_name": name,
        "license_summary": summary,
        "license_url": url,
        "gated": bool(info.get("gated")),
        "recommended": False,
        "recommendation": None,
        "trainable": False,
        "template_kwargs": {},
        "stop_tokens": [],
        "popularity": int(info.get("downloads") or 0),
        "position": 10_000,
        "family": "",
        "generation": "",
        "architecture": architecture,
        "tier": size_tier,
        "params_b": round(params, 2),
        "moe": moe,
        "support": "supported" if architecture in SUPPORTED_ARCHITECTURES else "untested",
        "superseded_by": None,
        "variants": [
            {
                "id": f"{identifier}:bf16:safetensors",
                "label": "Safetensors",
                "format": "safetensors",
                "precision": str(config.get("torch_dtype") or "bf16"),
                "repo": repo,
                "revision": info["sha"],
                "files": files,
                "size_bytes": sum(item["size"] for item in files),
                "weights_bytes": weights,
                "runtimes": ["transformers", "sglang", "vllm"],
                "requires": requires,
            }
        ],
    }


def lookup(text: str) -> dict[str, Any]:
    if hub.offline():
        raise HubAddError("Offline: adding a model from Hugging Face needs a connection")
    repo = parse_repo(text)
    with httpx.Client(timeout=TIMEOUT, headers=hub.headers(), follow_redirects=True) as client:
        info, config = fetch(client, repo)
    return describe(repo, info, config)
