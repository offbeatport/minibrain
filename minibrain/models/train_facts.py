from functools import lru_cache

from sqlalchemy.orm import Session

from minibrain.data.snapshot import read_split
from minibrain.ml.planner import Base, Machine, estimated_tokens
from minibrain.models.registry import base_config, quantization
from minibrain.models.rules import context_of, shape_of
from minibrain.registry.compute import Pool
from minibrain.registry.models import CatalogModel, CatalogVariant, Model
from minibrain.settings import Settings

FULL_PRECISION = {"bf16", "fp16", "fp32", "bfloat16", "float16", "float32"}
BYTES_PER_PARAM = {"fp32": 4, "float32": 4}
TRAINER_ROLE = "worker"


def variant_quantization(variant: CatalogVariant) -> str | None:
    if variant.format != "safetensors":
        return variant.format
    return None if variant.precision in FULL_PRECISION else variant.precision


def catalogue_base(entry: CatalogModel, variant: CatalogVariant) -> Base:
    return Base.of(
        entry.name,
        entry.params_b,
        variant.weights_bytes,
        entry.context_tokens,
        entry.shape,
        entry.moe,
        variant_quantization(variant),
    )


def safetensors_bytes(model: Model) -> int:
    return sum(int(item.get("size") or 0) for item in model.files if str(item.get("path", "")).endswith(".safetensors"))


def imported_base(settings: Settings, model: Model, quantized: str | None) -> Base:
    config = base_config(settings, model) or {}
    weights = safetensors_bytes(model) or model.size_bytes
    dtype = str(config.get("torch_dtype") or config.get("dtype") or "bf16")
    params = weights / BYTES_PER_PARAM.get(dtype, 2)
    return Base.of(model.name, params / 1e9, weights, context_of(config), shape_of(config), False, quantized)


def base_facts(session: Session, settings: Settings, key: str) -> Base:
    quantized = quantization(session, settings, key)
    model = session.get(Model, key)
    entry = session.get(CatalogModel, model.catalog_id if model and model.catalog_id else key)
    if entry is not None and entry.variants:
        variant = (model.variant if model else None) or entry.variants[0]
        found = catalogue_base(entry, variant)
        name = model.name if model else entry.name
        return Base(name, found.params, found.context, found.shape, found.moe, found.quantized or quantized)
    if model is not None:
        return imported_base(settings, model, quantized)
    return Base.of(key, None, None, None, None, False, quantized)


def trainer_machines(found: list[Pool]) -> list[Machine]:
    return [
        Machine.from_report(node.report)
        for pool in found
        for node in pool.nodes
        if node.online and TRAINER_ROLE in node.roles
    ]


def pool_trainers(pool: Pool) -> list[Machine]:
    return trainer_machines([pool])


@lru_cache(maxsize=32)
def longest_example(location: str, max_rows: int) -> tuple[int, int]:
    examples = read_split(location, "train")[:max_rows]
    longest = max((len(example.input) + len(example.label) for example in examples), default=0)
    return len(examples), estimated_tokens(longest)
