import os

import torch


def pick_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def training_device() -> str:
    return os.environ.get("MINIBRAIN_TRAIN_DEVICE") or ("cuda" if torch.cuda.is_available() else "cpu")
