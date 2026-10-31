from pathlib import Path

from minibrain.base_models import BaseModelSpec

SNAPSHOT_PATTERNS = ["*.json", "*.safetensors", "*.txt", "*.model", "*.jinja", "*.tiktoken"]


def present(spec: BaseModelSpec) -> Path | None:
    if not spec.path:
        return None
    folder = Path(spec.path)
    marker = folder / spec.weights_file if spec.weights_file else folder / "config.json"
    return folder if marker.is_file() else None


def local_dir(spec: BaseModelSpec, offline: bool = False) -> Path:
    found = present(spec)
    if found is not None:
        return found
    from huggingface_hub import snapshot_download

    patterns = [spec.weights_file, "*.json"] if spec.weights_file else SNAPSHOT_PATTERNS
    return Path(
        snapshot_download(spec.repo, revision=spec.revision or None, allow_patterns=patterns, local_files_only=offline)
    )


def gguf_path(spec: BaseModelSpec) -> Path:
    if not spec.weights_file:
        raise ValueError(f"{spec.key} has no GGUF weights file")
    return local_dir(spec) / spec.weights_file
