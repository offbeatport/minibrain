import os
import platform
import sys
from dataclasses import asdict, dataclass, field
from typing import Any

GIB = 1024**3
INFERENCE_OVERHEAD = 1.2
FIXED_OVERHEAD = int(0.5 * GIB)
FITS_SHARE = 0.8
LOCAL_POOL = "local"
LOCAL_LABEL = "This machine"
FIT_RANK = {"fits": 0, "limited": 1, "unknown": 2, "insufficient": 3}
MEMORY_LABELS = {"cuda": "GPU memory", "rocm": "GPU memory", "mps": "GPU-usable unified memory"}


@dataclass(frozen=True)
class Hardware:
    machine: str
    accelerator: str
    kind: str
    memory_bytes: int | None
    ram_bytes: int | None
    memory_label: str
    gpus: int = 0

    @property
    def known(self) -> bool:
        return self.memory_bytes is not None

    def as_dict(self) -> dict[str, Any]:
        return asdict(self) | {"known": self.known}


@dataclass(frozen=True)
class Gpu:
    name: str
    memory_bytes: int


@dataclass(frozen=True)
class NodeReport:
    host: str
    system: str
    arch: str
    cpu_count: int
    ram_bytes: int | None
    accelerator: str
    accelerator_name: str
    usable_bytes: int | None
    gpus: list[Gpu] = field(default_factory=list)
    engines: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "NodeReport":
        return NodeReport(
            host=str(data.get("host") or "unknown"),
            system=str(data.get("system") or ""),
            arch=str(data.get("arch") or ""),
            cpu_count=int(data.get("cpu_count") or 0),
            ram_bytes=data.get("ram_bytes"),
            accelerator=str(data.get("accelerator") or "cpu"),
            accelerator_name=str(data.get("accelerator_name") or ""),
            usable_bytes=data.get("usable_bytes"),
            gpus=[Gpu(str(gpu["name"]), int(gpu["memory_bytes"])) for gpu in data.get("gpus") or []],
            engines=[str(engine) for engine in data.get("engines") or []],
        )

    def hardware(self) -> Hardware:
        label = MEMORY_LABELS.get(self.accelerator, "RAM")
        return Hardware(
            self.host, self.accelerator_name, self.accelerator, self.usable_bytes, self.ram_bytes, label, len(self.gpus)
        )


def ram_bytes() -> int | None:
    try:
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    except (ValueError, OSError, AttributeError):
        return None


def gpu_report() -> tuple[str, str, list[Gpu], int | None]:
    import torch

    arch = platform.machine()
    if torch.cuda.is_available():
        kind = "rocm" if getattr(torch.version, "hip", None) else "cuda"
        devices = [torch.cuda.get_device_properties(index) for index in range(torch.cuda.device_count())]
        gpus = [Gpu(device.name, int(device.total_memory)) for device in devices]
        first = devices[0]
        name = f"{first.name} (compute {first.major}.{first.minor})"
        return kind, name if len(gpus) == 1 else f"{len(gpus)} x {name}", gpus, sum(gpu.memory_bytes for gpu in gpus)
    if torch.backends.mps.is_available():
        usable = int(torch.mps.recommended_max_memory()) if hasattr(torch.mps, "recommended_max_memory") else None
        name = f"Apple GPU ({arch})"
        return "mps", name, [Gpu(name, usable)] if usable else [], usable
    cpu = platform.processor() or arch or "CPU"
    return "cpu", f"{cpu}, {os.cpu_count() or 1} cores", [], ram_bytes()


def report() -> NodeReport:
    from minibrain.serve.select import installed_engines

    kind, name, gpus, usable = gpu_report()
    system, arch = sys.platform, platform.machine()
    return NodeReport(
        host=platform.node() or "localhost",
        system=system,
        arch=arch,
        cpu_count=os.cpu_count() or 1,
        ram_bytes=ram_bytes(),
        accelerator=kind,
        accelerator_name=name,
        usable_bytes=usable,
        gpus=gpus,
        engines=installed_engines(system, arch, kind),
    )


def detect() -> Hardware:
    return report().hardware()


def needed_bytes(weights_bytes: int) -> int:
    return int(weights_bytes * INFERENCE_OVERHEAD) + FIXED_OVERHEAD


def fit(weights_bytes: int, requires: dict[str, Any], hardware: Hardware | None) -> dict[str, Any]:
    need = needed_bytes(weights_bytes)
    weights = weights_bytes / GIB
    basis = f"Needs about {need / GIB:.1f} GB to serve: {weights:.1f} GB weights x {INFERENCE_OVERHEAD} + 0.5 GB."
    if hardware is None or not hardware.known or hardware.memory_bytes is None:
        return {"level": "unknown", "needed_bytes": need, "available_bytes": None, "basis": basis}
    accelerator = requires.get("accelerator")
    refusal = None
    if accelerator and accelerator != hardware.kind:
        refusal = requires.get("note") or f"Needs a {accelerator.upper()} accelerator."
    elif requires.get("gpus") == "multi" and hardware.gpus < 2:
        refusal = requires.get("note") or "Needs several GPUs."
    if refusal:
        return {
            "level": "insufficient",
            "needed_bytes": need,
            "available_bytes": hardware.memory_bytes,
            "basis": refusal,
        }
    available = hardware.memory_bytes
    level = "fits" if need <= available * FITS_SHARE else "limited" if need <= available else "insufficient"
    detail = f"{basis} {hardware.machine} has {available / GIB:.1f} GB {hardware.memory_label}."
    return {"level": level, "needed_bytes": need, "available_bytes": available, "basis": detail}


def pool_fit(weights_bytes: int, requires: dict[str, Any], machines: list[Hardware]) -> dict[str, Any]:
    if not machines:
        unknown = fit(weights_bytes, requires, None)
        return unknown | {"basis": f"{unknown['basis']} No machine in this pool has reported its hardware yet."}
    return min(
        (fit(weights_bytes, requires, machine) for machine in machines), key=lambda found: FIT_RANK[found["level"]]
    )
