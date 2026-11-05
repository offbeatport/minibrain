import math
from dataclasses import asdict, dataclass, field
from typing import Any

GIB = 1024**3
HEADROOM = 0.85
EFFECTIVE_BATCH = 16
MICRO_BATCHES = (8, 4, 2, 1)
MPS_MICRO_BATCHES = (1,)
LORA_DROPOUT = 0.05
PROMPT_TOKENS = 48
CHARS_PER_TOKEN = 4
SEQ_STEP = 16
MIN_SEQ = 32
REFERENCE_SEQ = 512
MAX_RANK = 64

LORA = "lora"
QLORA = "qlora"
STRATEGIES = (LORA, QLORA)
QUANTIZER = "bitsandbytes"
QLORA_EXTRA = "minibrain[qlora]"
GPU_KINDS = ("cuda", "rocm", "xpu")
DEVICES = {"cuda": "cuda", "rocm": "cuda", "xpu": "xpu", "mps": "mps", "cpu": "cpu"}
MEMORY_LABELS = {
    "cuda": "GPU memory",
    "rocm": "GPU memory",
    "xpu": "GPU memory",
    "mps": "GPU-usable unified memory",
    "cpu": "RAM",
}

NF4_BYTES = 0.516
LOGIT_BYTES = 12
FIXED_OVERHEAD = {"cuda": 1.0 * GIB, "xpu": 1.0 * GIB, "mps": 0.5 * GIB, "cpu": 1.0 * GIB}
FRAGMENTATION = 1.1

DEVICE_SPEED = {"cuda": 1.0, "xpu": 0.5, "mps": 0.15, "cpu": 0.05}
STRATEGY_SPEED = {LORA: 1.0, QLORA: 0.7}
CHECKPOINT_SPEED = 0.75
BATCH_SPEED = {1: 0.55, 2: 0.75, 4: 0.9, 8: 1.0}


class PlanError(ValueError):
    pass


@dataclass(frozen=True)
class Shape:
    hidden: int
    layers: int
    vocab: int
    heads: int
    kv_heads: int
    head_dim: int
    intermediate: int
    tied: bool = False

    @property
    def q_dim(self) -> int:
        return self.heads * self.head_dim

    @property
    def kv_dim(self) -> int:
        return self.kv_heads * self.head_dim

    @property
    def embedding_params(self) -> int:
        return self.vocab * self.hidden * (1 if self.tied else 2)

    @property
    def dense_params(self) -> int:
        attention = 2 * self.hidden * self.q_dim + 2 * self.hidden * self.kv_dim
        return self.embedding_params + self.layers * (attention + 3 * self.hidden * self.intermediate)

    @staticmethod
    def from_dict(data: dict[str, Any] | None) -> "Shape | None":
        if not data:
            return None
        try:
            return Shape(
                hidden=int(data["hidden"]),
                layers=int(data["layers"]),
                vocab=int(data["vocab"]),
                heads=int(data["heads"]),
                kv_heads=int(data["kv_heads"]),
                head_dim=int(data["head_dim"]),
                intermediate=int(data["intermediate"]),
                tied=bool(data.get("tied", False)),
            )
        except (KeyError, TypeError, ValueError):
            return None

    @staticmethod
    def guess(params: float) -> "Shape":
        billions = max(params / 1e9, 0.05)
        width = 40_000 * billions**0.62
        layers = max(12, min(96, round(28 * billions**0.18)))
        hidden = max(512, round(width / layers / 128) * 128)
        heads = max(1, hidden // 128)
        return Shape(hidden, layers, 152_064, heads, max(1, heads // 4), 128, round(hidden * 3.5), False)


@dataclass(frozen=True)
class Base:
    name: str
    params: float
    context: int | None
    shape: Shape
    moe: bool = False
    quantized: str | None = None

    @staticmethod
    def of(
        name: str,
        params_b: float | None,
        weights_bytes: int | None,
        context: int | None,
        shape: dict[str, Any] | None,
        moe: bool = False,
        quantized: str | None = None,
    ) -> "Base":
        listed = (params_b or 0.0) * 1e9 or (weights_bytes or 0) / 2
        found = Shape.from_dict(shape)
        params = found.dense_params if found is not None and not moe else listed
        return Base(name, params, context, found or Shape.guess(listed), moe, quantized)

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "params": self.params,
            "context": self.context,
            "shape": asdict(self.shape),
            "moe": self.moe,
            "quantized": self.quantized,
        }

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "Base":
        params = float(data["params"])
        shape = Shape.from_dict(data.get("shape")) or Shape.guess(params)
        return Base(str(data["name"]), params, data.get("context"), shape, bool(data.get("moe")), data.get("quantized"))


@dataclass(frozen=True)
class Machine:
    name: str
    kind: str
    gpu_bytes: int | None
    ram_bytes: int | None
    libraries: frozenset[str] = field(default_factory=frozenset)

    @property
    def device(self) -> str:
        return DEVICES.get(self.kind, "cpu")

    @property
    def memory_label(self) -> str:
        return MEMORY_LABELS.get(self.kind, "memory")

    @property
    def available_bytes(self) -> int | None:
        return self.ram_bytes if self.device == "cpu" else self.gpu_bytes

    @property
    def quantizes(self) -> bool:
        return self.kind in GPU_KINDS and QUANTIZER in self.libraries

    @property
    def micro_batches(self) -> tuple[int, ...]:
        return MPS_MICRO_BATCHES if self.device == "mps" else MICRO_BATCHES

    @staticmethod
    def from_report(report: Any) -> "Machine":
        gpus = [int(gpu.memory_bytes) for gpu in report.gpus]
        memory = max(gpus) if gpus else report.usable_bytes
        name = report.accelerator_name or report.host
        return Machine(name, report.accelerator, memory, report.ram_bytes, frozenset(report.versions))


@dataclass(frozen=True)
class Settings:
    strategy: str | None = None
    checkpointing: bool | None = None
    micro_batch: int | None = None
    seq_len: int | None = None
    rank: int = 16
    learning_rate: float = 2e-4
    epochs: float = 1.0
    max_rows: int = 3000

    def overrides(self) -> list[str]:
        defaults = Settings()
        return [name for name, value in asdict(self).items() if value != getattr(defaults, name)]


@dataclass(frozen=True)
class Option:
    strategy: str
    checkpointing: bool
    micro_batch: int
    grad_accum: int
    device: str
    precision: str
    optimizer: str
    peak_bytes: int
    parts: dict[str, int]
    available_bytes: int | None
    supported: bool = True
    reason: str | None = None

    @property
    def usable_bytes(self) -> int | None:
        return None if self.available_bytes is None else int(self.available_bytes * HEADROOM)

    @property
    def roomy(self) -> bool:
        usable = self.usable_bytes
        return usable is None or self.peak_bytes <= usable

    @property
    def fits(self) -> bool:
        return self.supported and self.roomy

    @property
    def speed(self) -> float:
        device = DEVICE_SPEED.get(self.device, 0.05)
        batch = BATCH_SPEED.get(self.micro_batch, 1.0)
        checkpoint = CHECKPOINT_SPEED if self.checkpointing else 1.0
        return device * STRATEGY_SPEED[self.strategy] * checkpoint * batch

    @property
    def label(self) -> str:
        name = "QLoRA 4-bit" if self.strategy == QLORA else f"LoRA {self.precision}"
        return f"{name}{' with checkpointing' if self.checkpointing else ''}"


@dataclass(frozen=True)
class Plan:
    base: Base
    machine: Machine | None
    settings: Settings
    seq_len: int
    rows: int
    chosen: Option | None
    options: list[Option]
    refusal: str | None = None
    note: str | None = None

    @property
    def basis(self) -> str:
        if self.refusal:
            return self.refusal
        chosen = self.chosen
        if chosen is None or chosen.available_bytes is None or self.machine is None:
            return "No machine that trains has reported its memory yet; the worker that takes the job plans on its own."
        return f"{chosen.label} · fits in {gigabytes(chosen.peak_bytes)} of {gigabytes(chosen.available_bytes)}"

    def recipe(self) -> dict[str, Any]:
        settings = self.settings
        chosen = self.chosen
        found: dict[str, Any] = {
            "max_rows": settings.max_rows,
            "epochs": settings.epochs,
            "rank": settings.rank,
            "alpha": 2 * settings.rank,
            "learning_rate": settings.learning_rate,
            "dropout": LORA_DROPOUT,
            "seq_len": self.seq_len,
            "overrides": settings.overrides(),
        }
        if chosen is None:
            return found
        return found | {
            "strategy": chosen.strategy,
            "checkpointing": chosen.checkpointing,
            "micro_batch": chosen.micro_batch,
            "grad_accum": chosen.grad_accum,
            "device": chosen.device,
            "precision": chosen.precision,
            "optimizer": chosen.optimizer,
            "plan": {
                "machine": self.machine.name if self.machine else None,
                "peak_bytes": chosen.peak_bytes,
                "available_bytes": chosen.available_bytes,
                "label": chosen.label,
            },
        }


def gigabytes(value: float) -> str:
    amount = value / GIB
    return f"{amount:.0f} GB" if amount >= 10 else f"{amount:.1f} GB"


def round_seq(tokens: int) -> int:
    return max(MIN_SEQ, SEQ_STEP * math.ceil(tokens / SEQ_STEP))


def estimated_tokens(characters: int) -> int:
    return math.ceil(characters / CHARS_PER_TOKEN) + PROMPT_TOKENS


def grad_accum_for(micro_batch: int) -> int:
    return max(1, round(EFFECTIVE_BATCH / micro_batch))


def lora_params(shape: Shape, rank: int) -> int:
    per_layer = 7 * shape.hidden + 2 * shape.q_dim + 2 * shape.kv_dim + 3 * shape.intermediate
    return rank * shape.layers * per_layer


def precision_of(machine: Machine) -> str:
    return "bf16" if machine.kind in GPU_KINDS else "fp32"


def optimizer_of(machine: Machine) -> str:
    if not machine.quantizes:
        return "adamw_torch"
    return "paged_adamw_8bit" if machine.kind == "cuda" else "adamw_8bit"


def weights_bytes(base: Base, strategy: str, element: int) -> int:
    if strategy == LORA:
        return int(base.params * element)
    embeddings = min(base.shape.embedding_params, base.params)
    return int((base.params - embeddings) * NF4_BYTES + embeddings * 2)


def adapter_bytes(base: Base, strategy: str, rank: int, optimizer: str) -> int:
    count = lora_params(base.shape, rank)
    states = 2 if "8bit" in optimizer else (4 if strategy == QLORA else 8)
    weights_and_grads = 4 if strategy == QLORA else 8
    return count * (weights_and_grads + states)


def activation_bytes(base: Base, machine: Machine, checkpointing: bool, tokens: int, seq: int, element: int) -> int:
    shape = base.shape
    full = 4 * shape.hidden + 4 * shape.q_dim + 3 * shape.kv_dim + 4 * shape.intermediate
    full += int(1.5 * (5 * shape.hidden + shape.q_dim + shape.intermediate))
    scores = 0 if machine.device == "cuda" else shape.heads * seq * element
    per_layer = full * element + scores
    stored = shape.layers * shape.hidden * element + per_layer if checkpointing else shape.layers * per_layer
    return tokens * stored


def support(machine: Machine, strategy: str) -> tuple[bool, str | None]:
    if strategy != QLORA or machine.quantizes:
        return True, None
    if machine.kind in GPU_KINDS:
        return False, f"QLoRA needs bitsandbytes on the worker ({QLORA_EXTRA})"
    return False, "QLoRA needs an NVIDIA GPU"


def estimate(
    base: Base, machine: Machine, strategy: str, checkpointing: bool, micro_batch: int, seq: int, rank: int
) -> Option:
    precision = precision_of(machine)
    element = 2 if precision == "bf16" else 4
    optimizer = optimizer_of(machine)
    tokens = micro_batch * seq
    dequantize = base.shape.hidden * max(base.shape.intermediate, base.shape.q_dim) * 2 if strategy == QLORA else 0
    dynamic = activation_bytes(base, machine, checkpointing, tokens, seq, element) + dequantize
    parts = {
        "weights": weights_bytes(base, strategy, element),
        "adapter": adapter_bytes(base, strategy, rank, optimizer),
        "activations": int(dynamic * FRAGMENTATION),
        "logits": int(tokens * base.shape.vocab * LOGIT_BYTES * FRAGMENTATION),
        "overhead": int(FIXED_OVERHEAD.get(machine.device, GIB)),
    }
    supported, reason = support(machine, strategy)
    return Option(
        strategy=strategy,
        checkpointing=checkpointing,
        micro_batch=micro_batch,
        grad_accum=grad_accum_for(micro_batch),
        device=machine.device,
        precision=precision,
        optimizer=optimizer,
        peak_bytes=sum(parts.values()),
        parts=parts,
        available_bytes=machine.available_bytes,
        supported=supported,
        reason=reason,
    )


def seq_len_for(base: Base, settings: Settings, longest_tokens: int) -> int:
    if settings.seq_len is not None:
        if base.context and settings.seq_len > base.context:
            raise PlanError(f"Sequence length {settings.seq_len:,} is past {base.name}'s context of {base.context:,}")
        return settings.seq_len
    fitted = round_seq(longest_tokens)
    return min(fitted, base.context) if base.context else fitted


def candidates(base: Base, machine: Machine, settings: Settings, seq: int, rows: int) -> list[Option]:
    strategies = [settings.strategy] if settings.strategy else list(STRATEGIES)
    checkpoints = [settings.checkpointing] if settings.checkpointing is not None else [False, True]
    allowed = [size for size in machine.micro_batches if size <= max(rows, 1)] or [1]
    batches = [settings.micro_batch] if settings.micro_batch else allowed
    return [
        estimate(base, machine, strategy, checkpointing, batch, seq, settings.rank)
        for strategy in strategies
        for checkpointing in checkpoints
        for batch in batches
    ]


def fastest(options: list[Option]) -> Option | None:
    return max(options, key=lambda option: (option.speed, -option.peak_bytes), default=None)


def best(options: list[Option]) -> Option | None:
    return fastest([option for option in options if option.fits])


def shown(options: list[Option]) -> list[Option]:
    found: list[Option] = []
    for strategy in STRATEGIES:
        for checkpointing in (False, True):
            group = [o for o in options if o.strategy == strategy and o.checkpointing == checkpointing]
            if group:
                found.append(best(group) or min(group, key=lambda option: option.peak_bytes))
    return found


def missed(options: list[Option], chosen: Option | None) -> str | None:
    wanted = fastest([option for option in options if option.roomy])
    if wanted is None or wanted.supported or (chosen is not None and chosen.speed >= wanted.speed):
        return None
    return f"{wanted.label} would fit in {gigabytes(wanted.peak_bytes)}, but {wanted.reason}."


def refusal(base: Base, machine: Machine, options: list[Option], settings: Settings, seq: int) -> str:
    supported = [option for option in options if option.supported]
    note = missed(options, None)
    if not supported:
        return f"{base.name} cannot train on {machine.name}: {note or 'no strategy runs there.'}"
    smallest = min(supported, key=lambda option: option.peak_bytes)
    available = machine.available_bytes or 0
    rows = "1 row" if smallest.micro_batch == 1 else f"{smallest.micro_batch} rows"
    fix = "Use a smaller base, shorter examples, or a machine with more memory."
    if settings.overrides():
        fix = "Change the settings back to the defaults, or use a smaller base or a machine with more memory."
    return (
        f"{base.name} does not fit for training on {machine.name}: the smallest plan, {smallest.label} at "
        f"{rows} of {seq:,} tokens, needs about {gigabytes(smallest.peak_bytes)}, and {machine.name} has "
        f"{gigabytes(available)} of {machine.memory_label} ({gigabytes(available * HEADROOM)} after "
        f"{round((1 - HEADROOM) * 100)}% headroom). {f'{note} ' if note else ''}{fix}"
    )


def plan_machine(base: Base, machine: Machine, settings: Settings, seq: int, rows: int) -> Plan:
    options = candidates(base, machine, settings, seq, rows)
    chosen = best(options)
    if chosen is None:
        reason = refusal(base, machine, options, settings, seq)
        return Plan(base, machine, settings, seq, rows, None, shown(options), reason)
    return Plan(base, machine, settings, seq, rows, chosen, shown(options), None, missed(options, chosen))


def validate(base: Base, settings: Settings) -> None:
    if base.quantized:
        raise PlanError(
            f"{base.name} has {base.quantized.upper()} weights, which can be served but not fine-tuned; "
            "train on its full-precision format"
        )
    if settings.rank > MAX_RANK:
        raise PlanError(f"LoRA rank {settings.rank} is above {MAX_RANK}, the largest rank the serving engines load")
    if settings.strategy is not None and settings.strategy not in STRATEGIES:
        raise PlanError(f"Unknown strategy {settings.strategy}; use one of {', '.join(STRATEGIES)}")


def plan(base: Base, machines: list[Machine], settings: Settings, longest_tokens: int, rows: int | None = None) -> Plan:
    validate(base, settings)
    seq = seq_len_for(base, settings, longest_tokens)
    count = min(rows if rows is not None else settings.max_rows, settings.max_rows)
    known = [machine for machine in machines if machine.available_bytes]
    if not known:
        return Plan(base, None, settings, seq, count, None, [])
    plans = [plan_machine(base, machine, settings, seq, count) for machine in known]
    fitting = [found for found in plans if found.chosen is not None]
    if fitting:
        return max(fitting, key=lambda found: found.chosen.speed if found.chosen else 0.0)
    return max(plans, key=lambda found: found.machine.available_bytes or 0 if found.machine else 0)


def minimum(base: Base, machine: Machine | None) -> Option:
    target = machine if machine is not None and machine.quantizes else None
    reference = target or Machine("An NVIDIA GPU", "cuda", None, None, frozenset({QUANTIZER}))
    return estimate(base, reference, QLORA, True, 1, REFERENCE_SEQ, Settings().rank)
