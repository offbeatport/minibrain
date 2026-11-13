import json
from dataclasses import replace
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
    estimate,
    estimated_tokens,
    eval_checks,
    plan,
    train_minutes,
    train_steps,
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


def register(harness: Harness, hardware: dict[str, Any], host: str = "gpu-box", pool: str = "local") -> None:
    body = {
        "id": f"worker-{host}",
        "host": host,
        "kinds": ["train", "eval"],
        "gpus": 1,
        "pool": pool,
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
    assert response.json()["detail"].startswith("Qwen3 0.6B does not fit for training on Test CPU in pool local")
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


def test_time_grows_with_the_work_and_slows_with_qlora_and_checkpointing() -> None:
    eight = base("qwen3-8b")
    lora = estimate(eight, A100, LORA, False, 8, 512, 16)
    minutes = train_minutes(eight, lora, 3000, 1, 16, 512, 300)
    assert 20 < minutes < 30
    assert train_minutes(eight, lora, 6000, 1, 16, 512, 300) > minutes
    assert train_minutes(eight, lora, 3000, 2, 16, 512, 300) > minutes
    assert train_minutes(eight, lora, 3000, 1, 32, 512, 300) > minutes
    assert train_minutes(eight, lora, 3000, 1, 16, 1024, 300) > minutes
    assert train_minutes(eight, estimate(eight, A100, QLORA, False, 8, 512, 16), 3000, 1, 16, 512, 300) > minutes
    assert train_minutes(eight, estimate(eight, A100, LORA, True, 8, 512, 16), 3000, 1, 16, 512, 300) > minutes
    assert train_minutes(eight, estimate(eight, XEON, LORA, False, 8, 512, 16), 3000, 1, 16, 512, 300) > minutes
    assert train_minutes(eight, lora, 3000, 1, 16, 512, 300, 5) > train_minutes(eight, lora, 3000, 1, 16, 512, 300, 100)
    assert train_minutes(eight, lora, 3000, 1, 16, 512, 0) < minutes
    assert train_steps(3000, 1, 8, 2) == 188
    assert train_steps(3000, 2.5, 4, 4) == 469
    assert (eval_checks(188, 50), eval_checks(188, None), eval_checks(5, None), eval_checks(1, 10)) == (4, 9, 5, 1)


def test_every_trainer_machine_is_planned_and_one_can_be_pinned() -> None:
    eight = base("qwen3-8b")
    silent = Machine("worker", "cuda", None, None)
    found = plan(eight, [M1_PRO, A100, silent], Settings(), 160, 3000)
    assert found.machine == A100
    assert [item.machine for item in found.machines] == [M1_PRO, A100, silent]
    mac, a100, unknown = found.machines
    assert mac.chosen is None
    assert mac.refusal is not None
    assert mac.refusal.startswith("Qwen3 8B does not fit for training on Apple GPU (arm64)")
    assert mac.smallest is not None
    assert mac.smallest.peak_bytes > (M1_PRO.available_bytes or 0) * HEADROOM
    assert a100.chosen is not None
    assert a100.steps == train_steps(3000, 1, a100.chosen.micro_batch, a100.chosen.grad_accum)
    assert (a100.minutes(100) or 0) > 2
    assert (unknown.chosen, unknown.refusal, unknown.minutes(100)) == (None, None, None)
    pinned = plan(eight, [M1_PRO, A100, silent], Settings(), 160, 3000, "Apple GPU (arm64)")
    assert (pinned.machine, pinned.chosen, pinned.refusal) == (M1_PRO, None, mac.refusal)
    assert len(pinned.machines) == 3
    with pytest.raises(PlanError, match="No training machine called H100"):
        plan(eight, [A100], Settings(), 160, 3000, "H100")


def test_a_pool_limits_the_machines_the_plan_chooses_from() -> None:
    eight = base("qwen3-8b")
    mac = replace(M1_PRO, pool="desk")
    a100 = replace(A100, pool="gpu-pool")
    found = plan(eight, [mac, a100], Settings(), 160, 3000, pool="desk")
    assert (found.machine, found.chosen) == (mac, None)
    assert [item.machine for item in found.machines] == [mac, a100]
    assert plan(eight, [mac, a100], Settings(), 160, 3000, pool="gpu-pool").machine == a100
    with pytest.raises(PlanError, match="No training machine called A100 80GB in the desk pool"):
        plan(eight, [mac, a100], Settings(), 160, 3000, "A100 80GB", "desk")
    with pytest.raises(PlanError, match="No training machine in the cloud pool"):
        plan(eight, [mac, a100], Settings(), 160, 3000, pool="cloud")


def test_alpha_accumulation_scoring_and_seed_reach_the_recipe() -> None:
    plain = plan(base("qwen3-0.6b"), [RTX_4090], Settings(rank=8), 160, 3000).recipe()
    assert (plain["alpha"], plain["seed"], plain["grad_accum"]) == (16, 7, 2)
    assert "eval_every" not in plain
    settings = Settings(alpha=24, grad_accum=4, eval_every=25, seed=11)
    found = plan(base("qwen3-0.6b"), [RTX_4090], settings, 160, 3000)
    assert found.chosen is not None
    assert found.chosen.grad_accum == 4
    recipe = found.recipe()
    assert (recipe["alpha"], recipe["grad_accum"], recipe["eval_every"], recipe["seed"]) == (24, 4, 25, 11)
    assert recipe["overrides"] == ["alpha", "grad_accum", "eval_every", "seed"]


def test_the_worker_keeps_alpha_seed_and_scoring_when_it_replans() -> None:
    from minibrain.ml.strategies import fit_here

    settings = Settings(alpha=8, grad_accum=4, eval_every=30, seed=3)
    stored = plan(base("qwen3-8b"), [A100], settings, 160, 3000).recipe()
    moved, replanned = fit_here(base("qwen3-8b"), RTX_4090, stored, encoded([100, 150]))
    assert replanned
    recipe = moved.recipe()
    assert (recipe["alpha"], recipe["grad_accum"], recipe["eval_every"], recipe["seed"]) == (8, 4, 30, 3)


def test_seed_and_scoring_steps_reach_the_trainer_config(tmp_path: Path) -> None:
    from minibrain.ml import train

    recipe = plan(base("qwen3-0.6b"), [RTX_4090], Settings(), 160, 3000).recipe()
    plain = train.sft_config(tmp_path, recipe, "cpu", evaluate=True)
    assert (plain.seed, plain.eval_steps) == (7, 0.1)
    chosen = train.sft_config(tmp_path, recipe | {"seed": 11, "eval_every": 25}, "cpu", evaluate=True)
    assert (chosen.seed, chosen.eval_steps) == (11, 25)
    assert train.sft_config(tmp_path, recipe | {"eval_every": 25}, "cpu").eval_steps is None


def test_training_plan_lists_every_machine_the_time_and_the_queue(harness: Harness) -> None:
    create_with_dataset(harness)
    register(harness, worker_hardware(24 * GIB, libraries=("bitsandbytes",)))
    register(harness, worker_hardware(2 * GIB, accelerator="cpu"), host="cpu-box")
    url = f"/api/models/{SLUG}/training-plan"
    found = harness.client.get(url).json()
    assert (found["level"], found["machine"]) == ("fits", "Test GPU")
    assert found["minutes"] > 2
    assert found["steps"] >= 1
    assert found["grad_accum"] == found["chosen"]["grad_accum"]
    assert found["held_out_rows"] > 0
    assert found["queue"] == {"ahead": 0, "running": 0, "jobs": []}
    assert found["defaults"] | {"alpha": 32, "seed": 7, "eval_every": None} == found["defaults"]
    machines = {item["name"]: item for item in found["machines"]}
    assert set(machines) == {"Test GPU", "Test CPU"}
    gpu, cpu = machines["Test GPU"], machines["Test CPU"]
    assert (gpu["fits"], gpu["picked"], gpu["pool"], gpu["kind"], gpu["reason"]) == (True, True, "local", "cuda", None)
    assert gpu["minutes"] == found["minutes"]
    assert (cpu["fits"], cpu["picked"], cpu["chosen"], cpu["minutes"]) == (False, False, None, None)
    assert cpu["reason"].startswith("Qwen3 0.6B does not fit for training on Test CPU in pool local")
    assert cpu["smallest"]["peak_bytes"] > cpu["available_bytes"] * HEADROOM
    pinned = harness.client.get(url, params={"machine": "Test CPU"}).json()
    assert (pinned["level"], pinned["machine"], pinned["minutes"]) == ("insufficient", "Test CPU", None)
    assert len(pinned["machines"]) == 2
    missing = harness.client.get(url, params={"machine": "H100"})
    assert missing.status_code == 409
    assert missing.json()["detail"] == "No training machine called H100"
    refused = harness.client.post(f"/api/models/{SLUG}/versions", json={"kind": "lora", "machine": "Test CPU"})
    assert refused.status_code == 409
    body = {"kind": "lora", "machine": "Test GPU", "alpha": 12, "grad_accum": 4, "eval_every": 20, "seed": 5}
    version = harness.client.post(f"/api/models/{SLUG}/versions", json=body)
    assert version.status_code == 201, version.text
    stored = version.json()["recipe"]
    assert (stored["alpha"], stored["grad_accum"], stored["eval_every"], stored["seed"]) == (12, 4, 20, 5)
    queued = harness.client.get(url).json()["queue"]
    assert (queued["ahead"], queued["running"]) == (1, 0)
    assert (
        queued["jobs"][0] | {"model": SLUG, "version": version.json()["number"], "status": "queued"}
        == (queued["jobs"][0])
    )
    claim = harness.claim(["train"])
    assert claim is not None
    assert claim["params"]["recipe"]["seed"] == 5


def test_a_pool_reaches_the_job_and_only_its_workers_claim_it(harness: Harness) -> None:
    create_with_dataset(harness)
    register(harness, worker_hardware(24 * GIB, libraries=("bitsandbytes",)))
    register(harness, worker_hardware(48 * GIB, libraries=("bitsandbytes",)), host="gpu-a10-1", pool="gpu-pool")
    url = f"/api/models/{SLUG}/training-plan"
    local = harness.client.get(url, params={"pool": "local"}).json()
    assert (local["level"], local["machine"]) == ("fits", "Test GPU on gpu-box")
    pooled = harness.client.get(url, params={"pool": "gpu-pool"}).json()
    assert pooled["machine"] == "Test GPU on gpu-a10-1"
    labels = {item["pool"]: item["pool_label"] for item in pooled["machines"]}
    assert labels == {"local": "This machine", "gpu-pool": "gpu-pool"}
    missing = harness.client.get(url, params={"pool": "cloud"})
    assert (missing.status_code, missing.json()["detail"]) == (409, "No training machine in the cloud pool")
    version = harness.client.post(f"/api/models/{SLUG}/versions", json={"kind": "lora", "pool": "gpu-pool"})
    assert version.status_code == 201, version.text
    assert harness.claim(["train"]) is None
    claim = harness.claim(["train"], worker_id="worker-gpu-a10-1", pool="gpu-pool")
    assert claim is not None
    assert claim["job_id"] == version.json()["job"]["id"]


def test_a_pinned_machine_holds_the_job_to_its_pool(harness: Harness) -> None:
    create_with_dataset(harness)
    register(harness, worker_hardware(24 * GIB, libraries=("bitsandbytes",)))
    register(harness, worker_hardware(48 * GIB, libraries=("bitsandbytes",)), host="gpu-a10-1", pool="gpu-pool")
    body = {"kind": "lora", "machine": "Test GPU on gpu-a10-1"}
    version = harness.client.post(f"/api/models/{SLUG}/versions", json=body)
    assert version.status_code == 201, version.text
    assert harness.claim(["train"]) is None
    assert harness.claim(["train"], worker_id="worker-gpu-a10-1", pool="gpu-pool") is not None
