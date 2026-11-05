from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
import torch
from transformers import TrainerControl, TrainerState, TrainingArguments

from minibrain.ml import devices, train


def fake_torch(cuda: bool = False, hip: str | None = None, xpu: bool | None = None, mps: bool = False, bf16=True):
    found: dict[str, Any] = {
        "cuda": SimpleNamespace(is_available=lambda: cuda, is_bf16_supported=lambda: bf16),
        "version": SimpleNamespace(hip=hip),
        "backends": SimpleNamespace(mps=SimpleNamespace(is_available=lambda: mps)),
        "bfloat16": torch.bfloat16,
        "float16": torch.float16,
        "float32": torch.float32,
    }
    if xpu is not None:
        found["xpu"] = SimpleNamespace(is_available=lambda: xpu, is_bf16_supported=lambda: bf16)
    return SimpleNamespace(**found)


@pytest.mark.parametrize(
    ("hardware", "expected"),
    [
        ({"cuda": True, "xpu": True, "mps": True}, "cuda"),
        ({"cuda": True, "hip": "7.2"}, "cuda"),
        ({"xpu": True, "mps": True}, "xpu"),
        ({"xpu": False, "mps": True}, "mps"),
        ({"mps": True}, "mps"),
        ({}, "cpu"),
    ],
)
def test_the_best_device_comes_first(monkeypatch: pytest.MonkeyPatch, hardware: dict[str, Any], expected: str):
    monkeypatch.setattr(devices, "torch", fake_torch(**hardware))
    monkeypatch.delenv(devices.TRAIN_DEVICE_ENV, raising=False)
    assert (devices.pick_device(), devices.training_device()) == (expected, expected)


def test_the_environment_forces_the_training_device(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(devices, "torch", fake_torch(cuda=True))
    monkeypatch.setenv(devices.TRAIN_DEVICE_ENV, "cpu")
    found = (devices.pick_device(), devices.training_device(), devices.forced_training_device())
    assert found == ("cuda", "cpu", "cpu")


@pytest.mark.parametrize(
    ("device", "bf16", "expected"),
    [
        ("cuda", True, torch.bfloat16),
        ("cuda:1", False, torch.float16),
        ("xpu", True, torch.bfloat16),
        ("xpu", False, torch.float16),
        ("mps", True, torch.float32),
        ("cpu", True, torch.float32),
    ],
)
def test_half_precision_only_where_the_device_supports_it(
    monkeypatch: pytest.MonkeyPatch, device: str, bf16: bool, expected: torch.dtype
):
    monkeypatch.setattr(devices, "torch", fake_torch(cuda=True, xpu=True, bf16=bf16))
    assert devices.weights_dtype(device) == expected


def test_mps_and_cpu_train_without_mixed_precision(tmp_path: Path):
    recipe = train.DEFAULT_RECIPE | {"batch_size": 4, "grad_accum": 2}
    found = {device: train.sft_config(tmp_path, recipe, device) for device in ("mps", "cpu")}
    assert {device: (config.bf16, config.fp16, config.use_cpu) for device, config in found.items()} == {
        "mps": (False, False, False),
        "cpu": (False, False, True),
    }
    batches = {
        device: (config.per_device_train_batch_size, config.gradient_accumulation_steps)
        for device, config in found.items()
    }
    assert batches == {"mps": (1, 8), "cpu": (4, 2)}


def hooks(tmp_path: Path) -> tuple[TrainingArguments, TrainerState, TrainerControl]:
    return TrainingArguments(output_dir=str(tmp_path), use_cpu=True, report_to="none"), TrainerState(), TrainerControl()


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def test_a_stall_is_judged_against_the_slowest_step(tmp_path: Path):
    clock = Clock()
    stall = train.StallWatch(clock)
    assert not stall.stalled()
    stall.on_train_begin(*hooks(tmp_path))
    clock.now = train.FIRST_STEP_SECONDS
    assert not stall.stalled()
    clock.now += 1
    assert stall.stalled()
    stall.on_step_end(*hooks(tmp_path))
    assert stall.limit() == train.STALL_FACTOR * (train.FIRST_STEP_SECONDS + 1)
    stall.longest = 1.0
    assert stall.limit() == train.STALL_SECONDS
    clock.now += train.STALL_SECONDS + 1
    assert stall.stalled()


def test_the_watch_reports_a_stall_once(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setattr(train, "WATCH_SECONDS", 0.01)
    clock = Clock()
    stall = train.StallWatch(clock)
    stall.on_train_begin(*hooks(tmp_path))
    clock.now = train.FIRST_STEP_SECONDS + 1
    reasons: list[str] = []
    train.watch(stall, reasons.append, train.threading.Event())
    assert reasons == [f"no training step finished on the Metal GPU in {train.FIRST_STEP_SECONDS:.0f} s"]


def mps_machine(monkeypatch: pytest.MonkeyPatch, forced: str | None = None) -> None:
    monkeypatch.setattr(devices, "torch", fake_torch(mps=True))
    if forced:
        monkeypatch.setenv(devices.TRAIN_DEVICE_ENV, forced)
    else:
        monkeypatch.delenv(devices.TRAIN_DEVICE_ENV, raising=False)


def test_a_job_that_failed_on_the_metal_gpu_stays_on_the_cpu(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    mps_machine(monkeypatch)
    mark, checkpoints = tmp_path / train.DEVICE_MARK, tmp_path / "checkpoints"
    assert train.chosen_device(mark, checkpoints) == "mps"
    (checkpoints / "checkpoint-50").mkdir(parents=True)
    assert train.chosen_device(mark, checkpoints) == "cpu"
    assert not checkpoints.exists()
    (checkpoints / "checkpoint-50").mkdir(parents=True)
    assert train.chosen_device(mark, checkpoints) == "cpu"
    assert (checkpoints / "checkpoint-50").is_dir()


def test_a_forced_device_never_falls_back(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    mps_machine(monkeypatch, forced="mps")
    mark = tmp_path / train.DEVICE_MARK
    assert [train.chosen_device(mark, tmp_path / "checkpoints") for _ in range(2)] == ["mps", "mps"]
    assert not mark.exists()


class Restarted(Exception):
    pass


def test_an_error_on_the_metal_gpu_restarts_on_the_cpu(monkeypatch: pytest.MonkeyPatch):
    reasons: list[str] = []

    def restart(reason: str):
        reasons.append(reason)
        raise Restarted

    class Failing:
        def train(self, resume_from_checkpoint: bool):
            raise RuntimeError("command buffer error")

    monkeypatch.setattr(train, "restart_on_cpu", restart)
    with pytest.raises(Restarted):
        train.train(Failing(), False, train.StallWatch())
    assert reasons == ["the Metal GPU failed: RuntimeError: command buffer error"]
    with pytest.raises(RuntimeError):
        train.train(Failing(), False, None)
