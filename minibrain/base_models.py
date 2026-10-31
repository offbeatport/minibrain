from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

QWEN_STOP_TOKENS = ("<|im_end|>", "<|endoftext|>")


@dataclass(frozen=True)
class BaseModelSpec:
    key: str
    repo: str
    revision: str
    license: str
    template_kwargs: dict[str, Any] = field(default_factory=dict)
    stop_tokens: tuple[str, ...] = QWEN_STOP_TOKENS
    path: str | None = None
    trainable: bool = True

    def source(self) -> tuple[str, str | None]:
        if self.path and (Path(self.path) / "config.json").is_file():
            return self.path, None
        return self.repo, self.revision

    def as_dict(self) -> dict[str, Any]:
        return asdict(self) | {"stop_tokens": list(self.stop_tokens)}

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "BaseModelSpec":
        return BaseModelSpec(
            key=str(data["key"]),
            repo=str(data["repo"]),
            revision=str(data["revision"]),
            license=str(data["license"]),
            template_kwargs=dict(data.get("template_kwargs") or {}),
            stop_tokens=tuple(data.get("stop_tokens") or QWEN_STOP_TOKENS),
            path=data.get("path"),
            trainable=bool(data.get("trainable", True)),
        )


QWEN3_0_6B = BaseModelSpec(
    key="qwen3-0.6b",
    repo="Qwen/Qwen3-0.6B",
    revision="c1899de289a04d12100db370d81485cdf75e47ca",
    license="Apache-2.0",
    template_kwargs={"enable_thinking": False},
)

BASE_MODELS = {spec.key: spec for spec in (QWEN3_0_6B,)}
DEFAULT_BASE_MODEL = QWEN3_0_6B.key


def base_model(key: str) -> BaseModelSpec:
    spec = BASE_MODELS.get(key)
    if spec is None:
        raise KeyError(f"unknown base model {key}")
    return spec
