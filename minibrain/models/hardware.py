import os
import platform
from dataclasses import asdict, dataclass
from typing import Any

GIB = 1024**3
INFERENCE_OVERHEAD = 1.2
FIXED_OVERHEAD = int(0.5 * GIB)
FITS_SHARE = 0.8


@dataclass(frozen=True)
class Hardware:
    machine: str
    accelerator: str
    kind: str
    memory_bytes: int | None
    ram_bytes: int | None
    memory_label: str

    @property
    def known(self) -> bool:
        return self.memory_bytes is not None

    def as_dict(self) -> dict[str, Any]:
        return asdict(self) | {"known": self.known}


def ram_bytes() -> int | None:
    try:
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    except (ValueError, OSError, AttributeError):
        return None


def detect() -> Hardware:
    import torch

    machine = platform.node() or "This machine"
    ram = ram_bytes()
    if torch.cuda.is_available():
        properties = torch.cuda.get_device_properties(0)
        name = f"{properties.name} (compute {properties.major}.{properties.minor})"
        return Hardware(machine, name, "cuda", properties.total_memory, ram, "GPU memory")
    if torch.backends.mps.is_available():
        usable = int(torch.mps.recommended_max_memory()) if hasattr(torch.mps, "recommended_max_memory") else None
        return Hardware(machine, f"Apple GPU ({platform.machine()})", "mps", usable, ram, "GPU-usable unified memory")
    cpu = platform.processor() or platform.machine() or "CPU"
    return Hardware(machine, f"{cpu}, {os.cpu_count() or 1} cores", "cpu", ram, ram, "RAM")


def needed_bytes(weights_bytes: int) -> int:
    return int(weights_bytes * INFERENCE_OVERHEAD) + FIXED_OVERHEAD


def fit(weights_bytes: int, requires: dict[str, Any], hardware: Hardware | None) -> dict[str, Any]:
    need = needed_bytes(weights_bytes)
    weights = weights_bytes / GIB
    basis = f"Needs about {need / GIB:.1f} GB to serve: {weights:.1f} GB weights x {INFERENCE_OVERHEAD} + 0.5 GB."
    if hardware is None or not hardware.known or hardware.memory_bytes is None:
        return {"level": "unknown", "needed_bytes": need, "available_bytes": None, "basis": basis}
    accelerator = requires.get("accelerator")
    if accelerator and accelerator != hardware.kind:
        reason = requires.get("note") or f"Needs a {accelerator.upper()} accelerator."
        return {
            "level": "insufficient",
            "needed_bytes": need,
            "available_bytes": hardware.memory_bytes,
            "basis": reason,
        }
    available = hardware.memory_bytes
    level = "fits" if need <= available * FITS_SHARE else "limited" if need <= available else "insufficient"
    detail = f"{basis} This machine has {available / GIB:.1f} GB {hardware.memory_label}."
    return {"level": level, "needed_bytes": need, "available_bytes": available, "basis": detail}
