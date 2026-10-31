import json
import re
import sys
from datetime import date
from pathlib import Path
from typing import Any

import httpx

HUB = "https://huggingface.co"
OUT = Path(__file__).resolve().parent.parent / "minibrain" / "catalog" / "catalog.json"

PUBLISHERS = {
    "Qwen": "Qwen",
    "google": "Google",
    "meta-llama": "Meta",
    "mistralai": "Mistral AI",
    "microsoft": "Microsoft",
    "ibm-granite": "IBM",
    "nvidia": "NVIDIA",
    "deepseek-ai": "DeepSeek",
    "openai": "OpenAI",
    "allenai": "Allen AI",
    "HuggingFaceTB": "Hugging Face",
}

LICENCES = {
    "apache-2.0": (
        "Apache 2.0",
        "Permissive: commercial use, changes and redistribution allowed; keep the licence and notices.",
        "https://www.apache.org/licenses/LICENSE-2.0",
    ),
    "mit": (
        "MIT",
        "Permissive: commercial use, changes and redistribution allowed; keep the copyright notice.",
        "https://opensource.org/license/mit",
    ),
    "llama3.1": (
        "Llama 3.1 Community Licence",
        "Commercial use allowed under Meta's acceptable-use policy; over 700M monthly users needs a separate "
        "licence; credit 'Built with Llama'.",
        "https://www.llama.com/llama3_1/license/",
    ),
    "llama3.2": (
        "Llama 3.2 Community Licence",
        "Commercial use allowed under Meta's acceptable-use policy; over 700M monthly users needs a separate "
        "licence; credit 'Built with Llama'.",
        "https://www.llama.com/llama3_2/license/",
    ),
    "llama3.3": (
        "Llama 3.3 Community Licence",
        "Commercial use allowed under Meta's acceptable-use policy; over 700M monthly users needs a separate "
        "licence; credit 'Built with Llama'.",
        "https://www.llama.com/llama3_3/license/",
    ),
    "gemma": (
        "Gemma Terms of Use",
        "Commercial use allowed under Google's prohibited-use policy; pass the terms on with the model.",
        "https://ai.google.dev/gemma/terms",
    ),
    "qwen": (
        "Qwen Licence",
        "Commercial use allowed; over 100M monthly users needs a separate licence from Alibaba Cloud.",
        "https://huggingface.co/Qwen/Qwen2.5-72B-Instruct/blob/main/LICENSE",
    ),
    "deepseek": (
        "DeepSeek Model Licence",
        "Commercial use allowed under DeepSeek's use restrictions; pass the terms on with the model.",
        "https://github.com/deepseek-ai/DeepSeek-V3/blob/main/LICENSE-MODEL",
    ),
    "nvidia-open-model-license": (
        "NVIDIA Open Model Licence",
        "Commercial use allowed; derivatives must keep NVIDIA's terms and attribution.",
        "https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/",
    ),
}

LICENCE_OVERRIDES = {
    "deepseek-ai/DeepSeek-V3": "deepseek",
    "nvidia/Llama-3.1-Nemotron-Nano-8B-v1": "nvidia-open-model-license",
}

SUPPORTED_ARCHITECTURES = {
    "qwen2",
    "qwen3",
    "qwen3_moe",
    "llama",
    "mistral",
    "mixtral",
    "gemma2",
    "gemma3_text",
    "phi3",
    "granite",
    "olmo2",
    "smollm3",
    "deepseek_v3",
    "gpt_oss",
}

TESTED_ARCHITECTURES = {"qwen3"}

QWEN3_TOKENS = {"stop_tokens": ["<|im_end|>", "<|endoftext|>"], "template_kwargs": {"enable_thinking": False}}
CHATML_TOKENS = {"stop_tokens": ["<|im_end|>", "<|endoftext|>"], "template_kwargs": {}}

CANDIDATES: list[dict[str, Any]] = [
    {
        "repo": "Qwen/Qwen3-0.6B",
        "family": "qwen",
        "generation": "3",
        "tokens": QWEN3_TOKENS,
        "gguf": "Qwen/Qwen3-0.6B-GGUF",
    },
    {
        "repo": "Qwen/Qwen3-1.7B",
        "family": "qwen",
        "generation": "3",
        "tokens": QWEN3_TOKENS,
        "gguf": "Qwen/Qwen3-1.7B-GGUF",
    },
    {
        "repo": "Qwen/Qwen3-4B",
        "family": "qwen",
        "generation": "3",
        "tokens": QWEN3_TOKENS,
        "gguf": "Qwen/Qwen3-4B-GGUF",
    },
    {
        "repo": "Qwen/Qwen3-8B",
        "family": "qwen",
        "generation": "3",
        "tokens": QWEN3_TOKENS,
        "fp8": "Qwen/Qwen3-8B-FP8",
        "gguf": "Qwen/Qwen3-8B-GGUF",
    },
    {"repo": "Qwen/Qwen3-14B", "family": "qwen", "generation": "3", "tokens": QWEN3_TOKENS},
    {"repo": "Qwen/Qwen3-32B", "family": "qwen", "generation": "3", "tokens": QWEN3_TOKENS},
    {"repo": "Qwen/Qwen3-30B-A3B", "family": "qwen", "generation": "3", "tokens": QWEN3_TOKENS},
    {"repo": "Qwen/Qwen3-235B-A22B", "family": "qwen", "generation": "3", "tokens": QWEN3_TOKENS},
    {"repo": "Qwen/Qwen3-4B-Instruct-2507", "family": "qwen", "generation": "3.2507", "tokens": CHATML_TOKENS},
    {"repo": "Qwen/Qwen3-30B-A3B-Instruct-2507", "family": "qwen", "generation": "3.2507", "tokens": CHATML_TOKENS},
    {
        "repo": "Qwen/Qwen3-Coder-30B-A3B-Instruct",
        "family": "qwen-coder",
        "generation": "3",
        "tokens": CHATML_TOKENS,
        "extra": ["Code"],
    },
    {"repo": "Qwen/Qwen2.5-0.5B-Instruct", "family": "qwen", "generation": "2.5", "tokens": CHATML_TOKENS},
    {"repo": "Qwen/Qwen2.5-1.5B-Instruct", "family": "qwen", "generation": "2.5", "tokens": CHATML_TOKENS},
    {"repo": "Qwen/Qwen2.5-3B-Instruct", "family": "qwen", "generation": "2.5", "tokens": CHATML_TOKENS},
    {"repo": "Qwen/Qwen2.5-7B-Instruct", "family": "qwen", "generation": "2.5", "tokens": CHATML_TOKENS},
    {"repo": "Qwen/Qwen2.5-14B-Instruct", "family": "qwen", "generation": "2.5", "tokens": CHATML_TOKENS},
    {"repo": "Qwen/Qwen2.5-32B-Instruct", "family": "qwen", "generation": "2.5", "tokens": CHATML_TOKENS},
    {"repo": "Qwen/Qwen2.5-72B-Instruct", "family": "qwen", "generation": "2.5", "tokens": CHATML_TOKENS},
    {
        "repo": "Qwen/Qwen2.5-Coder-7B-Instruct",
        "family": "qwen-coder",
        "generation": "2.5",
        "tokens": CHATML_TOKENS,
        "extra": ["Code"],
    },
    {"repo": "google/gemma-3-1b-it", "family": "gemma", "generation": "3"},
    {"repo": "google/gemma-2-2b-it", "family": "gemma", "generation": "2"},
    {"repo": "google/gemma-2-9b-it", "family": "gemma", "generation": "2"},
    {"repo": "google/gemma-2-27b-it", "family": "gemma", "generation": "2"},
    {"repo": "meta-llama/Llama-3.2-1B-Instruct", "family": "llama", "generation": "3.2"},
    {"repo": "meta-llama/Llama-3.2-3B-Instruct", "family": "llama", "generation": "3.2"},
    {"repo": "meta-llama/Llama-3.1-8B-Instruct", "family": "llama", "generation": "3.1"},
    {"repo": "meta-llama/Llama-3.3-70B-Instruct", "family": "llama", "generation": "3.3"},
    {"repo": "mistralai/Mistral-7B-Instruct-v0.3", "family": "mistral", "generation": "0.3"},
    {"repo": "mistralai/Mistral-Nemo-Instruct-2407", "family": "mistral-nemo", "generation": "2407"},
    {"repo": "mistralai/Mistral-Small-24B-Instruct-2501", "family": "mistral-small", "generation": "2501"},
    {"repo": "mistralai/Mixtral-8x7B-Instruct-v0.1", "family": "mixtral", "generation": "0.1"},
    {"repo": "microsoft/Phi-3.5-mini-instruct", "family": "phi-mini", "generation": "3.5"},
    {"repo": "microsoft/Phi-4-mini-instruct", "family": "phi-mini", "generation": "4"},
    {"repo": "microsoft/phi-4", "family": "phi", "generation": "4"},
    {"repo": "ibm-granite/granite-3.1-8b-instruct", "family": "granite", "generation": "3.1"},
    {"repo": "ibm-granite/granite-3.3-2b-instruct", "family": "granite", "generation": "3.3"},
    {"repo": "ibm-granite/granite-3.3-8b-instruct", "family": "granite", "generation": "3.3"},
    {"repo": "nvidia/Llama-3.1-Nemotron-Nano-8B-v1", "family": "nemotron-nano", "generation": "1"},
    {
        "repo": "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B",
        "family": "deepseek-r1-distill",
        "generation": "1",
        "extra": ["Reasoning"],
    },
    {
        "repo": "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B",
        "family": "deepseek-r1-distill",
        "generation": "1",
        "extra": ["Reasoning"],
    },
    {
        "repo": "deepseek-ai/DeepSeek-R1-Distill-Llama-8B",
        "family": "deepseek-r1-distill",
        "generation": "1",
        "extra": ["Reasoning"],
    },
    {
        "repo": "deepseek-ai/DeepSeek-R1-Distill-Qwen-14B",
        "family": "deepseek-r1-distill",
        "generation": "1",
        "extra": ["Reasoning"],
    },
    {
        "repo": "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B",
        "family": "deepseek-r1-distill",
        "generation": "1",
        "extra": ["Reasoning"],
    },
    {
        "repo": "deepseek-ai/DeepSeek-R1-Distill-Llama-70B",
        "family": "deepseek-r1-distill",
        "generation": "1",
        "extra": ["Reasoning"],
    },
    {"repo": "deepseek-ai/DeepSeek-V3", "family": "deepseek-v3", "generation": "3"},
    {"repo": "openai/gpt-oss-20b", "family": "gpt-oss", "generation": "1", "extra": ["Reasoning"]},
    {"repo": "openai/gpt-oss-120b", "family": "gpt-oss", "generation": "1", "extra": ["Reasoning"]},
    {"repo": "allenai/OLMo-2-0425-1B-Instruct", "family": "olmo", "generation": "2.2504"},
    {"repo": "allenai/OLMo-2-1124-7B-Instruct", "family": "olmo", "generation": "2.2411"},
    {"repo": "allenai/OLMo-2-1124-13B-Instruct", "family": "olmo", "generation": "2.2411"},
    {"repo": "HuggingFaceTB/SmolLM2-360M-Instruct", "family": "smollm", "generation": "2"},
    {"repo": "HuggingFaceTB/SmolLM2-1.7B-Instruct", "family": "smollm", "generation": "2"},
    {"repo": "HuggingFaceTB/SmolLM3-3B", "family": "smollm", "generation": "3"},
]

KEEP_FILES = {
    "config.json",
    "generation_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.json",
    "merges.txt",
    "special_tokens_map.json",
    "added_tokens.json",
    "model.safetensors.index.json",
    "chat_template.jinja",
    "LICENSE",
    "USE_POLICY.md",
}

GGUF_PREFERENCE = ("Q8_0", "q8_0", "Q4_K_M")


def needed(path: str) -> bool:
    duplicate = path.startswith("consolidated")
    return "/" not in path and not duplicate and (path in KEEP_FILES or path.endswith(".safetensors"))


def slug(repo: str) -> str:
    return re.sub(r"[^a-z0-9.]+", "-", repo.split("/", 1)[1].lower()).strip("-")


def tier(params: float, moe: bool, weights_gb: float) -> str:
    if params >= 60 or weights_gb > 80:
        return "XL"
    if params >= 20 or moe:
        return "L"
    if params > 5:
        return "M"
    return "S"


def files_of(info: dict[str, Any], keep: Any) -> list[dict[str, Any]]:
    found = []
    for sibling in info.get("siblings", []):
        if keep(sibling["rfilename"]):
            lfs = sibling.get("lfs") or {}
            size = sibling.get("size") or lfs.get("size") or 0
            found.append({"path": sibling["rfilename"], "size": size, "sha256": lfs.get("sha256")})
    return sorted(found, key=lambda item: item["path"])


class Builder:
    def __init__(self, client: httpx.Client) -> None:
        self.client = client
        self.rejected: list[str] = []

    def info(self, repo: str) -> dict[str, Any] | None:
        response = self.client.get(f"{HUB}/api/models/{repo}", params={"blobs": "true"})
        return response.json() if response.status_code == 200 else None

    def config(self, repo: str, revision: str) -> dict[str, Any]:
        response = self.client.get(f"{HUB}/{repo}/resolve/{revision}/config.json")
        return response.json() if response.status_code == 200 else {}

    def reject(self, repo: str, reason: str) -> None:
        self.rejected.append(f"{repo}: {reason}")

    def licence(self, repo: str, info: dict[str, Any]) -> str | None:
        card = info.get("cardData") or {}
        found = card.get("license")
        if found == "other":
            found = card.get("license_name")
        found = LICENCE_OVERRIDES.get(repo) or found
        return found if found in LICENCES else None

    def variant(self, entry_id: str, repo: str, info: dict[str, Any], precision: str, requires: dict) -> dict:
        files = files_of(info, needed)
        weights = sum(item["size"] for item in files if item["path"].endswith(".safetensors"))
        return {
            "id": f"{entry_id}:{precision}:safetensors",
            "label": f"{precision.upper()} safetensors",
            "format": "safetensors",
            "precision": precision,
            "repo": repo,
            "revision": info["sha"],
            "files": files,
            "size_bytes": sum(item["size"] for item in files),
            "weights_bytes": weights,
            "runtimes": ["transformers", "sglang", "vllm"] + (["mlx"] if not requires.get("accelerator") else []),
            "requires": requires,
        }

    def gguf_variant(self, entry_id: str, repo: str) -> dict[str, Any] | None:
        info = self.info(repo)
        if info is None:
            return None
        ggufs = [s["rfilename"] for s in info.get("siblings", []) if s["rfilename"].endswith(".gguf")]
        chosen = next((name for marker in GGUF_PREFERENCE for name in ggufs if marker in name), None)
        if chosen is None:
            return None
        files = files_of(info, lambda path: path in (chosen, "LICENSE"))
        quant = next(marker for marker in GGUF_PREFERENCE if marker in chosen).lower()
        return {
            "id": f"{entry_id}:{quant}:gguf",
            "label": f"GGUF {quant.upper()}",
            "format": "gguf",
            "precision": quant,
            "repo": repo,
            "revision": info["sha"],
            "files": files,
            "size_bytes": sum(item["size"] for item in files),
            "weights_bytes": sum(item["size"] for item in files if item["path"].endswith(".gguf")),
            "runtimes": ["llama.cpp"],
            "requires": {},
        }

    def entry(self, candidate: dict[str, Any], previous: dict[str, Any] | None) -> dict[str, Any] | None:
        repo = candidate["repo"]
        organisation = repo.split("/", 1)[0]
        if organisation not in PUBLISHERS:
            self.reject(repo, "publisher not approved")
            return None
        info = self.info(repo)
        if info is None:
            self.reject(repo, "not found on the hub")
            return None
        licence = self.licence(repo, info)
        if licence is None:
            self.reject(repo, f"licence {(info.get('cardData') or {}).get('license')} not enterprise-acceptable")
            return None
        config = (info.get("config") or {}) | self.config(repo, info["sha"])
        architecture = config.get("model_type", "")
        if architecture not in SUPPORTED_ARCHITECTURES:
            self.reject(repo, f"architecture {architecture or 'unknown'} not supported by our engines")
            return None
        if not any(s["rfilename"].endswith(".safetensors") for s in info.get("siblings", [])):
            self.reject(repo, "no safetensors weights")
            return None
        entry_id = previous["id"] if previous else slug(repo)
        variant = self.variant(entry_id, repo, info, "bf16", {})
        params = ((info.get("safetensors") or {}).get("total") or variant["weights_bytes"] / 2) / 1e9
        moe = (
            "moe" in architecture
            or "num_experts" in config
            or "num_local_experts" in config
            or architecture == "gpt_oss"
        )
        size_tier = tier(params, moe and params > 15, variant["weights_bytes"] / 1e9)
        if size_tier == "XL":
            variant["requires"] = {"gpus": "multi", "note": "Needs several datacenter GPUs."}
            variant["runtimes"] = ["sglang", "vllm"]
        variants = [variant]
        if candidate.get("fp8"):
            fp8 = self.info(candidate["fp8"])
            if fp8 is not None:
                requires = {"accelerator": "cuda", "note": "FP8 weights need an NVIDIA GPU (CUDA)."}
                variants.append(self.variant(entry_id, candidate["fp8"], fp8, "fp8", requires))
        if candidate.get("gguf"):
            gguf = self.gguf_variant(entry_id, candidate["gguf"])
            if gguf is not None:
                variants.append(gguf)
        name, summary, url = LICENCES[licence]
        tokens = candidate.get("tokens", {"stop_tokens": [], "template_kwargs": {}})
        tested = architecture in TESTED_ARCHITECTURES
        base = {
            "id": entry_id,
            "name": repo.split("/", 1)[1].replace("-", " ").replace("_", " "),
            "description": f"{PUBLISHERS[organisation]} instruct model, {params:.1f}B parameters"
            + (" (mixture of experts)" if moe else "")
            + ".",
            "provider": PUBLISHERS[organisation],
            "repo": repo,
            "capabilities": ["Chat", "Classification", "Extraction", *candidate.get("extra", [])],
            "recommended": False,
            "recommendation": None,
            "trainable": tested and not moe,
            "gated": bool(info.get("gated")),
            "stop_tokens": tokens["stop_tokens"],
            "template_kwargs": tokens["template_kwargs"],
        }
        if previous:
            base |= {
                key: previous[key]
                for key in (
                    "name",
                    "description",
                    "capabilities",
                    "recommended",
                    "recommendation",
                    "trainable",
                    "stop_tokens",
                    "template_kwargs",
                )
                if key in previous
            }
            kept = {variant["id"]: variant for variant in previous["variants"]}
            variants = [
                kept.get(variant["id"], variant) | {"runtimes": variant["runtimes"], "requires": variant["requires"]}
                for variant in variants
            ]
        return base | {
            "popularity": int(info.get("downloads") or 0),
            "license": licence,
            "license_name": name,
            "license_summary": summary,
            "license_url": url,
            "family": candidate["family"],
            "generation": candidate["generation"],
            "architecture": architecture,
            "tier": size_tier,
            "params_b": round(params, 2),
            "support": "tested" if tested else "supported",
            "moe": moe,
            "variants": variants,
        }


def generation_key(value: str) -> tuple[float, ...]:
    return tuple(float(part) for part in value.split(".") if part.replace(".", "").isdigit())


def mark_superseded(entries: list[dict[str, Any]]) -> None:
    for entry in entries:
        newer = [
            other
            for other in entries
            if other["family"] == entry["family"]
            and generation_key(other["generation"]) > generation_key(entry["generation"])
            and other["moe"] == entry["moe"]
            and 1 / 1.5 <= other["params_b"] / entry["params_b"] <= 1.5
        ]
        best = max(
            newer,
            key=lambda e: (generation_key(e["generation"]), -abs(e["params_b"] - entry["params_b"])),
            default=None,
        )
        entry["superseded_by"] = best["id"] if best else None


def main() -> None:
    previous = {entry["repo"]: entry for entry in json.loads(OUT.read_text())["entries"]} if OUT.exists() else {}
    with httpx.Client(timeout=httpx.Timeout(30.0), follow_redirects=True) as client:
        builder = Builder(client)
        entries = []
        for candidate in CANDIDATES:
            found = builder.entry(candidate, previous.get(candidate["repo"]))
            if found is not None:
                entries.append(found)
                print(f"ok  {found['tier']:>2} {found['id']}", file=sys.stderr)
    mark_superseded(entries)
    for position, entry in enumerate(entries):
        entry["position"] = position
    for line in builder.rejected:
        print(f"skip {line}", file=sys.stderr)
    stamp = f"{date.today().isoformat()}.9"
    OUT.write_text(json.dumps({"snapshot": stamp, "source": HUB, "entries": entries}, indent=1) + "\n")
    print(f"{len(entries)} entries, {len(builder.rejected)} rejected -> {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
