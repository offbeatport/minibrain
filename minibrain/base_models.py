from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class BaseModelSpec:
    key: str
    repo: str
    revision: str
    license: str
    template_kwargs: dict[str, Any] = field(default_factory=dict)


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
