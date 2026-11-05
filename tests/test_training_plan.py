import json
from pathlib import Path
from typing import Any

import pytest

from minibrain.ml.examples import Encoded
from minibrain.ml.planner import (
    GIB,
    HEADROOM,
    LORA,
    QLORA,
    Base,
    Machine,
    PlanError,
    Settings,
    estimated_tokens,
    plan,
)
from minibrain.models.hardware import Gpu, NodeReport
from minibrain.tasks.contracts import label_set
from minibrain.tasks.examples import single
from minibrain.tasks.prompting import Prompting
from tests.conftest import Harness
from tests.test_flow import SLUG, create_with_dataset

CATALOG = Path(__file__).resolve().parent.parent / "minibrain" / "catalog" / "catalog.json"
ENTRIES = {entry["id"]: entry for entry in json.loads(CATALOG.read_text())["entries"]}
BNB = frozenset({"bitsandbytes"})
RTX_4090 = Machine("RTX 4090", "cuda", 24 * GIB, 64 * GIB, BNB)
L4_PLAIN = Machine("L4", "cuda", 24 * GIB, 64 * GIB, frozenset())
RTX_5090 = Machine("RTX 5090", "cuda", 32 * GIB, 64 * GIB, BNB)
A100 = Machine("A100 80GB", "cuda", 80 * GIB, 256 * GIB, BNB)
MI300X = Machine("MI300X", "rocm", 192 * GIB, 512 * GIB, BNB)
M1_PRO = Machine("Apple GPU (arm64)", "mps", int(10.7 * GIB), 16 * GIB, frozenset())
XEON = Machine("Xeon", "cpu", None, 64 * GIB, BNB)


def base(identifier: str) -> Base:
    entry = ENTRIES[identifier]
    variant = entry["variants"][0]
    return Base.of(
        entry["name"],
        entry["params_b"],
        variant["weights_bytes"],
        entry["context_tokens"],
        entry["shape"],
        entry["moe"],
    )


def chosen(identifier: str, machine: Machine, settings: Settings | None = None) -> tuple[str, bool, int]:
    found = plan(base(identifier), [machine], settings or Settings(), 160, 3000)
    assert found.chosen is not None, found.refusal
    assert found.chosen.peak_bytes <= (machine.available_bytes or 0) * HEADROOM
    return found.chosen.strategy, found.chosen.checkpointing, found.chosen.micro_batch


@pytest.mark.parametrize(
    ("identifier", "machine", "expected"),
    [
        ("qwen3-0.6b", RTX_4090, (LORA, False, 8)),
        ("qwen3-8b", RTX_4090, (LORA, True, 8)),
        ("qwen3-14b", RTX_4090, (QLORA, True, 8)),
        ("qwen3-32b", RTX_5090, (QLORA, True, 8)),
        ("qwen3-32b", A100, (LORA, True, 8)),
        ("llama-3.3-70b-instruct", A100, (QLORA, True, 8)),
        ("llama-3.3-70b-instruct", MI300X, (LORA, True, 8)),
        ("qwen3-0.6b", M1_PRO, (LORA, False, 1)),
        ("qwen3-4b", XEON, (LORA, False, 8)),
    ],
)
def test_the_fastest_strategy_that_fits_with_headroom_is_chosen(
    identifier: str, machine: Machine, expected: tuple[str, bool, int]
) -> None:
    assert chosen(identifier, machine) == expected


def test_basis_names_the_strategy_and_the_memory() -> None:
    found = plan(base("qwen3-14b"), [RTX_4090], Settings(), 160, 3000)
    assert found.basis == "QLoRA 4-bit with checkpointing · fits in 14 GB of 24 GB"
    recipe = found.recipe()
    assert (recipe["strategy"], recipe["checkpointing"], recipe["micro_batch"], recipe["grad_accum"]) == (
        QLORA,
        True,
        8,
        2,
    )
    assert (recipe["optimizer"], recipe["precision"], recipe["seq_len"]) == ("paged_adamw_8bit", "bf16", 160)
    assert recipe["plan"]["label"] == "QLoRA 4-bit with checkpointing"


def test_rocm_quantizes_with_bitsandbytes_without_paged_optimisers() -> None:
    found = plan(base("llama-3.3-70b-instruct"), [Machine("MI250", "rocm", 64 * GIB, 256 * GIB, BNB)], Settings(), 160)
    assert found.chosen is not None
    assert (found.chosen.strategy, found.chosen.optimizer) == (QLORA, "adamw_8bit")


def test_nothing_fits_refuses_with_the_smallest_plan_and_the_memory() -> None:
    found = plan(base("qwen3-14b"), [L4_PLAIN], Settings(), 160, 3000)
    assert found.chosen is None
    assert found.refusal == (
        "Qwen3 14B does not fit for training on L4: the smallest plan, LoRA bf16 with checkpointing at 1 row of 160 "
        "tokens, needs about 30 GB, and L4 has 24 GB of GPU memory (20 GB after 15% headroom). QLoRA 4-bit with "
        "checkpointing would fit in 14 GB, but QLoRA needs bitsandbytes on the worker (minibrain[qlora]). Use a "
        "smaller base, shorter examples, or a machine with more memory."
    )


def test_apple_silicon_says_qlora_needs_an_nvidia_gpu() -> None:
    found = plan(base("qwen3-4b"), [M1_PRO], Settings(), 160, 3000)
    assert found.chosen is None
    assert found.refusal is not None
    assert "QLoRA needs an NVIDIA GPU" in found.refusal
    assert [option.supported for option in found.options] == [True, True, False, False]


def test_overriding_to_qlora_on_a_mac_is_refused() -> None:
    found = plan(base("qwen3-0.6b"), [M1_PRO], Settings(strategy=QLORA), 160, 3000)
    assert found.chosen is None
    assert found.refusal == (
        "Qwen3 0.6B cannot train on Apple GPU (arm64): QLoRA 4-bit would fit in 2.2 GB, but QLoRA needs an NVIDIA GPU."
    )


def test_the_faster_machine_wins_and_unknown_memory_plans_nothing() -> None:
    found = plan(base("qwen3-1.7b"), [XEON, RTX_4090], Settings(), 160, 3000)
    assert found.machine == RTX_4090
    unknown = plan(base("qwen3-1.7b"), [Machine("worker", "cuda", None, None)], Settings(), 160, 3000)
    assert (unknown.chosen, unknown.refusal, unknown.machine) == (None, None, None)
    assert "plans on its own" in unknown.basis


def test_overrides_pin_the_plan_and_are_recorded() -> None:
    settings = Settings(strategy=QLORA, checkpointing=False, micro_batch=2, seq_len=512, rank=32, learning_rate=1e-4)
    found = plan(base("qwen3-0.6b"), [RTX_4090], settings, 160, 3000)
    assert found.chosen is not None
    assert (found.chosen.strategy, found.chosen.checkpointing, found.chosen.micro_batch) == (QLORA, False, 2)
    recipe = found.recipe()
    assert (recipe["seq_len"], recipe["rank"], recipe["alpha"], recipe["learning_rate"]) == (512, 32, 64, 1e-4)
    assert recipe["overrides"] == ["strategy", "checkpointing", "micro_batch", "seq_len", "rank", "learning_rate"]


def test_sequence_length_fits_the_data_and_the_context() -> None:
    assert plan(base("qwen3-0.6b"), [RTX_4090], Settings(), 150, 3000).seq_len == 160
    assert plan(base("olmo-2-1b-instruct"), [A100], Settings(), 9000, 3000).seq_len == 4096
    with pytest.raises(PlanError, match="past OLMo 2 1B Instruct's context of 4,096"):
        plan(base("olmo-2-1b-instruct"), [A100], Settings(seq_len=8192), 100, 3000)
    assert estimated_tokens(400) == 148


def test_quantized_weights_cannot_be_planned() -> None:
    quantized = Base("Qwen3 8B FP8", 8e9, 40960, base("qwen3-8b").shape, quantized="fp8")
    with pytest.raises(PlanError, match="FP8 weights, which can be served but not fine-tuned"):
        plan(quantized, [A100], Settings(), 100)


def test_larger_micro_batches_are_never_planned_past_the_rows() -> None:
    found = plan(base("qwen3-0.6b"), [RTX_4090], Settings(), 160, 3)
    assert found.chosen is not None
    assert found.chosen.micro_batch == 2


def worker_hardware(memory: int | None, accelerator: str = "cuda", libraries: tuple[str, ...] = ()) -> dict[str, Any]:
    gpus = [Gpu("Test GPU", memory)] if memory and accelerator != "cpu" else []
    report = NodeReport(
        host="gpu-box",
        system="linux",
        arch="x86_64",
        cpu_count=16,
        ram_bytes=64 * GIB if accelerator != "cpu" else memory,
        accelerator=accelerator,
        accelerator_name="Test GPU" if accelerator != "cpu" else "Test CPU",
        usable_bytes=memory,
        gpus=gpus,
        versions={name: "1.0" for name in libraries},
    )
    return report.as_dict()


def register(harness: Harness, hardware: dict[str, Any], host: str = "gpu-box") -> None:
    body = {
        "id": f"worker-{host}",
        "host": host,
        "kinds": ["train", "eval"],
        "gpus": 1,
        "pool": "local",
        "hardware": hardware,
    }
    assert harness.internal("/register", body).status_code == 204


def test_training_plan_reads_the_data_and_the_worker(harness: Harness) -> None:
    create_with_dataset(harness)
    unknown = harness.client.get(f"/api/models/{SLUG}/training-plan").json()
    assert (unknown["level"], unknown["chosen"], unknown["machine"]) == ("unknown", None, None)
    register(harness, worker_hardware(24 * GIB, libraries=("bitsandbytes",)))
    found = harness.client.get(f"/api/models/{SLUG}/training-plan").json()
    assert (found["level"], found["machine"], found["rows"]) == ("fits", "Test GPU", 146)
    assert found["chosen"]["label"] == "LoRA bf16"
    assert found["basis"].startswith("LoRA bf16 · fits in ")
    assert [option["label"] for option in found["options"]] == [
        "LoRA bf16",
        "LoRA bf16 with checkpointing",
        "QLoRA 4-bit",
        "QLoRA 4-bit with checkpointing",
    ]
    assert found["defaults"] == found["defaults"] | {"strategy": "lora", "rank": 16, "max_rows": 3000}
    pinned = harness.client.get(f"/api/models/{SLUG}/training-plan?strategy=qlora&micro_batch=2").json()
    assert pinned["chosen"]["strategy"] == "qlora"
    assert pinned["chosen"]["micro_batch"] == 2
    assert pinned["overrides"] == ["strategy", "micro_batch"]
    assert pinned["defaults"]["strategy"] == "lora"


def test_overrides_are_validated(harness: Harness) -> None:
    create_with_dataset(harness)
    url = f"/api/models/{SLUG}/versions"
    for body in ({"micro_batch": 0}, {"learning_rate": 1}, {"strategy": "dora"}, {"rank": 512}, {"seq_len": 8}):
        assert harness.client.post(url, json={"kind": "lora", **body}).status_code == 422, body
    response = harness.client.post(url, json={"kind": "lora", "seq_len": 50_000})
    assert response.status_code == 409
    assert "past Qwen3 0.6B's context of 40,960" in response.json()["detail"]


def test_a_version_that_cannot_fit_is_refused_up_front(harness: Harness) -> None:
    create_with_dataset(harness)
    register(harness, worker_hardware(2 * GIB, accelerator="cpu"))
    response = harness.client.post(f"/api/models/{SLUG}/versions", json={"kind": "lora"})
    assert response.status_code == 409
    assert response.json()["detail"].startswith("Qwen3 0.6B does not fit for training on Test CPU")
    assert harness.claim(["train"]) is None


def test_the_chosen_settings_reach_the_training_job(harness: Harness) -> None:
    create_with_dataset(harness)
    register(harness, worker_hardware(24 * GIB, libraries=("bitsandbytes",)))
    body = {"kind": "lora", "strategy": "qlora", "rank": 8, "epochs": 2, "max_rows": 100, "seq_len": 128}
    version = harness.client.post(f"/api/models/{SLUG}/versions", json=body)
    assert version.status_code == 201, version.text
    stored = version.json()["recipe"]
    assert (stored["strategy"], stored["rank"], stored["alpha"], stored["seq_len"]) == ("qlora", 8, 16, 128)
    claim = harness.claim(["train"])
    assert claim is not None
    recipe = claim["params"]["recipe"]
    assert recipe | stored == recipe
    assert recipe["optimizer"] == "paged_adamw_8bit"
    assert set(recipe["overrides"]) == {"strategy", "rank", "epochs", "max_rows", "seq_len"}
    assert claim["params"]["plan_base"]["shape"]["hidden"] == 1024


def test_catalogue_variants_carry_the_memory_to_train(harness: Harness) -> None:
    catalogue = harness.client.get("/api/catalog").json()
    entries = {entry["id"]: entry for entry in catalogue["entries"]}
    small = entries["qwen3-0.6b"]["variants"][0]["train_fit"]
    assert (small["level"], small["available_bytes"]) == ("unknown", None)
    assert 1 * GIB < small["qlora_bytes"] < 4 * GIB
    register(harness, worker_hardware(24 * GIB, libraries=("bitsandbytes",)))
    entries = {entry["id"]: entry for entry in harness.client.get("/api/catalog").json()["entries"]}
    variants = {variant["format"] + variant["precision"]: variant for variant in entries["qwen3-8b"]["variants"]}
    assert variants["safetensorsbf16"]["train_fit"]["level"] == "fits"
    assert variants["safetensorsfp8"]["train_fit"]["level"] == "unsupported"
    assert variants["ggufq8_0"]["train_fit"]["qlora_bytes"] is None
    assert entries["llama-3.3-70b-instruct"]["variants"][0]["train_fit"]["level"] == "insufficient"


def encoded(lengths: list[int]) -> list[Encoded]:
    return [Encoded(list(range(length)), length // 2) for length in lengths]


def test_the_worker_keeps_the_stored_plan_when_it_fits_and_replans_when_not() -> None:
    from minibrain.ml.strategies import fit_here

    stored = plan(base("qwen3-8b"), [A100], Settings(), 160, 3000).recipe()
    kept, replanned = fit_here(base("qwen3-8b"), A100, stored, encoded([100, 150]))
    assert not replanned
    assert kept.chosen is not None
    assert (kept.chosen.strategy, kept.chosen.micro_batch, kept.seq_len) == (stored["strategy"], 8, 160)
    moved, replanned = fit_here(base("qwen3-8b"), RTX_4090, stored, encoded([100, 150]))
    assert replanned
    assert moved.chosen is not None
    assert moved.chosen.peak_bytes <= 24 * GIB * HEADROOM


def test_an_override_that_no_longer_fits_on_the_worker_fails() -> None:
    from minibrain.ml.strategies import fit_here

    stored = plan(base("qwen3-8b"), [A100], Settings(strategy=LORA, checkpointing=False), 160, 3000).recipe()
    found, _ = fit_here(base("qwen3-8b"), M1_PRO, stored, encoded([100]))
    assert found.chosen is None
    assert found.refusal is not None
    assert found.refusal.endswith(
        "Change the settings back to the defaults, or use a smaller base or a machine with more memory."
    )


def test_the_chosen_settings_reach_the_trainer_config(tmp_path: Path) -> None:
    from minibrain.ml import train
    from minibrain.ml.strategies import quantization_config

    recipe = plan(base("qwen3-14b"), [RTX_4090], Settings(), 160, 3000).recipe()
    config = train.sft_config(tmp_path, recipe, "cpu")
    assert (config.num_train_epochs, config.learning_rate, config.max_length) == (1.0, 2e-4, 160)
    assert (config.per_device_train_batch_size, config.gradient_accumulation_steps) == (8, 2)
    assert (config.gradient_checkpointing, config.gradient_checkpointing_kwargs) == (True, {"use_reentrant": False})
    assert getattr(config.optim, "value", config.optim) == "paged_adamw_8bit"
    lora = train.lora_config(recipe | {"rank": 8, "alpha": 16})
    assert (lora.r, lora.lora_alpha, lora.lora_dropout, lora.target_modules) == (8, 16, 0.05, "all-linear")
    quantized = quantization_config(recipe, "cpu")
    assert quantized is not None
    assert (quantized.load_in_4bit, quantized.bnb_4bit_quant_type, quantized.bnb_4bit_use_double_quant) == (
        True,
        "nf4",
        True,
    )
    assert quantization_config(recipe | {"strategy": LORA}, "cuda") is None


def test_examples_are_measured_the_way_trl_tokenizes_them() -> None:
    from minibrain.ml.examples import encode, longest, truncated

    class Tokenizer:
        def apply_chat_template(self, messages: list[dict[str, str]], **options: Any) -> list[int]:
            text = "".join(f"<{m['role']}>{m['content']}" for m in messages)
            prompt = "<assistant>" if options.get("add_generation_prompt") else ""
            return [ord(character) for character in text + prompt]

    prompting = Prompting(
        "Classify the input. Answer with the label only.", label_set(["billing", "bug"]), trained=True
    )
    [found] = encode(Tokenizer(), prompting, single("hi", "billing"), {})
    prompt = len("<system>Classify the input. Answer with the label only.<user>hi<assistant>")
    assert found.offset == prompt
    assert len(found.tokens) == prompt + len("billing")
    assert longest([found]) == len(found.tokens)
    assert truncated([found], 10) == 1
