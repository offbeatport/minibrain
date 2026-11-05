from typing import Any, Literal

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
    "zai-org": "Z.ai",
}


def publisher_of(repo: str | None) -> str | None:
    return PUBLISHERS.get(repo.split("/", 1)[0]) if repo else None


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

LicenceUse = Literal["commercial", "restricted", "non-commercial", "unknown"]

LICENCE_USE: dict[str, LicenceUse] = {
    "apache-2.0": "commercial",
    "mit": "commercial",
    "llama3.1": "restricted",
    "llama3.2": "restricted",
    "llama3.3": "restricted",
    "gemma": "restricted",
    "qwen": "restricted",
    "deepseek": "restricted",
    "nvidia-open-model-license": "restricted",
}


def licence_use(licence: str) -> LicenceUse:
    if licence in LICENCE_USE:
        return LICENCE_USE[licence]
    if licence.startswith("cc-by-nc"):
        return "non-commercial"
    return "unknown"


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
    "glm4",
    "glm4_moe",
}


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


def needed(path: str) -> bool:
    duplicate = path.startswith("consolidated")
    return "/" not in path and not duplicate and (path in KEEP_FILES or path.endswith(".safetensors"))


def context_of(config: dict[str, Any]) -> int | None:
    for section in (config, config.get("text_config") or {}):
        value = section.get("max_position_embeddings")
        if isinstance(value, int) and value > 0:
            return value
    return None


def whole(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def active_intermediate(text: dict[str, Any], dense: int) -> int:
    per_expert = whole(text.get("moe_intermediate_size"))
    chosen = whole(text.get("num_experts_per_tok"))
    if per_expert is None or chosen is None:
        return dense
    shared = whole(text.get("shared_expert_intermediate_size")) or 0
    return per_expert * (chosen + (whole(text.get("n_shared_experts")) or 0)) + shared


def shape_of(config: dict[str, Any]) -> dict[str, Any] | None:
    text = config.get("text_config") or config
    hidden, layers, vocab = (whole(text.get(key)) for key in ("hidden_size", "num_hidden_layers", "vocab_size"))
    if hidden is None or layers is None or vocab is None:
        return None
    heads = whole(text.get("num_attention_heads")) or max(1, hidden // 128)
    head_dim = whole(text.get("head_dim")) or hidden // heads
    dense = whole(text.get("intermediate_size")) or 4 * hidden
    tied = text.get("tie_word_embeddings", config.get("tie_word_embeddings", False))
    return {
        "hidden": hidden,
        "layers": layers,
        "vocab": vocab,
        "heads": heads,
        "kv_heads": whole(text.get("num_key_value_heads")) or heads,
        "head_dim": head_dim,
        "intermediate": active_intermediate(text, dense),
        "tied": bool(tied),
    }


def released_of(info: dict[str, Any]) -> str | None:
    created = info.get("createdAt")
    return created[:10] if isinstance(created, str) and len(created) >= 10 else None


def tier(params: float, moe: bool, weights_gb: float) -> str:
    if params >= 60 or weights_gb > 80:
        return "XL"
    if params >= 20 or moe:
        return "L"
    if params > 5:
        return "M"
    return "S"
