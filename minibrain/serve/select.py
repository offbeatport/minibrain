import importlib.util
import os
import sys

from minibrain.models.hardware import NodeReport

ENGINES = ("sglang", "mlx", "transformers", "llamacpp")
ADAPTER_ENGINES = frozenset({"sglang", "mlx", "transformers"})
PREFERRED = ("sglang", "mlx")
GPU_KINDS = frozenset({"cuda", "rocm"})


class NoEngineError(Exception):
    pass


def importable(module: str) -> bool:
    return importlib.util.find_spec(module) is not None


def sglang_python() -> str | None:
    explicit = os.environ.get("MINIBRAIN_SGLANG_PYTHON")
    if explicit:
        return explicit
    return sys.executable if importable("sglang") else None


def installed_engines(system: str, arch: str, accelerator: str) -> list[str]:
    found: list[str] = []
    if system == "linux" and accelerator in GPU_KINDS and sglang_python():
        found.append("sglang")
    if system == "darwin" and arch == "arm64" and importable("mlx_lm"):
        found.append("mlx")
    found.append("transformers")
    if importable("llama_cpp"):
        found.append("llamacpp")
    return found


def choose_engine(node: NodeReport, weights_format: str, requested: str | None = None) -> str:
    gguf = weights_format == "gguf"
    if requested and requested != "auto":
        if requested not in node.engines:
            raise NoEngineError(f"{requested} is not available on {node.host}; it has {', '.join(node.engines)}")
        if gguf != (requested == "llamacpp"):
            raise NoEngineError(f"{requested} cannot serve {weights_format} weights")
        return requested
    if gguf:
        if "llamacpp" in node.engines:
            return "llamacpp"
        raise NoEngineError(f"GGUF weights need llama.cpp; install minibrain[llamacpp] on {node.host}")
    return next((engine for engine in PREFERRED if engine in node.engines), "transformers")
