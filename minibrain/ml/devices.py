import os
import platform

import torch


def pick_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def training_device() -> str:
    return os.environ.get("MINIBRAIN_TRAIN_DEVICE") or ("cuda" if torch.cuda.is_available() else "cpu")


def device_name(device: str) -> str:
    if device.startswith("cuda") and torch.cuda.is_available():
        return torch.cuda.get_device_name(torch.device(device))
    if device == "mps":
        return f"Apple GPU ({platform.machine()})"
    return platform.processor() or platform.machine() or "CPU"
