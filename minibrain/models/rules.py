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


def tier(params: float, moe: bool, weights_gb: float) -> str:
    if params >= 60 or weights_gb > 80:
        return "XL"
    if params >= 20 or moe:
        return "L"
    if params > 5:
        return "M"
    return "S"
