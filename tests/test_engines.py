import json
import sys
from dataclasses import replace
from pathlib import Path

import pytest

from minibrain.base_models import QWEN3_0_6B, BaseModelSpec
from minibrain.models.hardware import GIB, Gpu, NodeReport
from minibrain.registry.models import Model
from minibrain.serve import engine as engine_module
from minibrain.serve import select
from minibrain.serve.backend import AdapterRef, CompletionRequest, TransformersBackend
from minibrain.serve.engine import load_backend, pull_base
from minibrain.serve.select import NoEngineError, choose_engine, installed_engines
from minibrain.serve.sglang_backend import SglangBackend
from tests.conftest import Harness
from tests.test_models import FILES, add_tiny, download_tiny, hub  # noqa: F401

LINUX_GPU = NodeReport(
    "gpu-01", "linux", "x86_64", 64, 512 * GIB, "cuda", "H100", 80 * GIB, [Gpu("H100", 80 * GIB)], []
)
MAC = NodeReport("mac", "darwin", "arm64", 10, 16 * GIB, "mps", "Apple GPU", 12 * GIB, [], [])
CPU = NodeReport("cpu-01", "linux", "x86_64", 16, 64 * GIB, "cpu", "x86_64, 16 cores", 64 * GIB, [], [])


def with_engines(node: NodeReport, *engines: str) -> NodeReport:
    return replace(node, engines=list(engines))


def test_each_node_picks_its_engine_from_hardware_and_format() -> None:
    assert choose_engine(with_engines(LINUX_GPU, "sglang", "transformers", "llamacpp"), "safetensors") == "sglang"
    assert choose_engine(with_engines(MAC, "mlx", "transformers", "llamacpp"), "safetensors") == "mlx"
    assert choose_engine(with_engines(CPU, "transformers", "llamacpp"), "safetensors") == "transformers"
    assert choose_engine(with_engines(CPU, "transformers", "llamacpp"), "gguf") == "llamacpp"
    assert choose_engine(with_engines(MAC, "mlx", "transformers"), "safetensors", "transformers") == "transformers"
    with pytest.raises(NoEngineError, match=r"llama\.cpp"):
        choose_engine(with_engines(MAC, "mlx", "transformers"), "gguf")
    with pytest.raises(NoEngineError, match="not available"):
        choose_engine(with_engines(MAC, "mlx", "transformers"), "safetensors", "sglang")
    with pytest.raises(NoEngineError, match="cannot serve"):
        choose_engine(with_engines(CPU, "transformers", "llamacpp"), "safetensors", "llamacpp")


def test_installed_engines_follow_platform(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(select, "importable", lambda _module: True)
    monkeypatch.setattr(select, "sglang_python", lambda: "/opt/sglang/bin/python")
    assert installed_engines("linux", "x86_64", "cuda") == ["sglang", "transformers", "llamacpp"]
    assert installed_engines("linux", "x86_64", "rocm")[0] == "sglang"
    assert installed_engines("linux", "x86_64", "cpu") == ["transformers", "llamacpp"]
    assert installed_engines("darwin", "arm64", "mps") == ["mlx", "transformers", "llamacpp"]


class Broken:
    def load(self, spec: BaseModelSpec) -> None:
        raise RuntimeError(f"cannot load {spec.key}")


def test_engine_falls_back_to_transformers_when_the_chosen_one_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(engine_module, "make_backend", lambda _engine, _materialize: Broken())
    monkeypatch.setattr(TransformersBackend, "load", lambda _self, _spec: None)
    node = with_engines(MAC, "mlx", "transformers")
    engine, backend = load_backend(QWEN3_0_6B, node, None, lambda _artifact: Path())
    assert engine == "transformers" and isinstance(backend, TransformersBackend)
    with pytest.raises(RuntimeError):
        load_backend(QWEN3_0_6B, node, "mlx", lambda _artifact: Path())


def test_sglang_runs_as_a_process_and_loads_adapters_on_demand(tmp_path: Path) -> None:
    log = tmp_path / "requests.jsonl"
    script = Path(__file__).parent / "fake_sglang.py"
    adapter_dir = tmp_path / "adapter"
    backend = SglangBackend(
        lambda _artifact: adapter_dir,
        command=lambda _spec, port: [sys.executable, str(script), "--port", str(port), "--log", str(log)],
        startup_seconds=30,
    )
    try:
        backend.load(QWEN3_0_6B)
        messages = [{"role": "user", "content": "hello"}]
        base = backend.complete(CompletionRequest(QWEN3_0_6B, messages, None, 8))
        adapter = AdapterRef("support@2", {"id": "x"})
        tuned = backend.complete(CompletionRequest(QWEN3_0_6B, messages, adapter, 8))
        again = backend.complete(CompletionRequest(QWEN3_0_6B, messages, adapter, 8))
    finally:
        backend.close()
    assert (base.text, tuned.text, again.text) == ("base:hello", "support@2:hello", "support@2:hello")
    assert (tuned.prompt_tokens, tuned.completion_tokens, tuned.stopped) == (7, 2, True)
    calls = [json.loads(line) for line in log.read_text().splitlines()]
    loads = [call["body"] for call in calls if call["path"] == "/load_lora_adapter"]
    assert loads == [{"lora_name": "support@2", "lora_path": str(adapter_dir)}]
    chat = [call["body"] for call in calls if call["path"] == "/v1/chat/completions"]
    assert chat[0]["chat_template_kwargs"] == {"enable_thinking": False} and "lora_path" not in chat[0]
    assert backend.status() == [{"base_model": "qwen3-0.6b", "device": "sglang", "adapters": ["support@2"]}]


def test_mlx_converts_peft_lora_weights(tmp_path: Path) -> None:
    pytest.importorskip("mlx_lm")
    import mlx.core as mx

    from minibrain.serve.mlx_backend import convert_peft

    prefix = "base_model.model.model.layers.0.self_attn.q_proj"
    tensors = {f"{prefix}.lora_A.weight": mx.ones((4, 16)), f"{prefix}.lora_B.weight": mx.zeros((32, 4))}
    mx.save_safetensors(str(tmp_path / "adapter_model.safetensors"), tensors)
    (tmp_path / "adapter_config.json").write_text(json.dumps({"peft_type": "LORA", "r": 4, "lora_alpha": 8}))
    adapter = convert_peft(tmp_path)
    assert (adapter.shape.rank, adapter.shape.scale, adapter.shape.keys) == (4, 2.0, ("self_attn.q_proj",))
    assert adapter.weights["model.layers.0.self_attn.q_proj.lora_a"].shape == (16, 4)
    assert adapter.weights["model.layers.0.self_attn.q_proj.lora_b"].shape == (4, 32)


def test_remote_engines_pull_weights_from_main_not_the_hub(harness: Harness, hub: Path, tmp_path: Path) -> None:  # noqa: F811
    add_tiny(harness)
    download_tiny(harness)
    assert harness.worker(kinds=["download"]).run_once()
    headers = harness.gateway_headers
    listed = harness.client.get("/internal/gateway/bases/tiny", headers=headers).json()
    assert set(FILES) <= {entry["path"] for entry in listed["files"]} and listed["spec"]["path"] is None
    assert harness.client.get("/internal/gateway/bases/tiny/files/../minibrain.db", headers=headers).status_code == 404
    assert harness.client.get("/internal/gateway/bases/tiny", headers={}).status_code == 401
    token = harness.settings.secret("gateway_token")
    spec = pull_base(harness.client, token, "tiny", tmp_path / "weights")
    assert spec.path == str(tmp_path / "weights") and spec.format == "safetensors"
    assert all((tmp_path / "weights" / name).read_bytes() == data for name, data in FILES.items())


def test_registered_engines_join_the_config_and_stop_local_spawns(harness: Harness, hub: Path) -> None:  # noqa: F811
    add_tiny(harness)
    download_tiny(harness)
    assert harness.worker(kinds=["download"]).run_once()
    with harness.sessions() as session:
        model = session.get(Model, "tiny")
        assert model is not None
        model.deployed = True
        session.commit()
    seen: list[dict] = []

    def spawn(specs: dict[str, BaseModelSpec], registered: dict[str, list[dict[str, str]]]) -> dict[str, str]:
        seen.append(registered)
        return {}

    harness.app.state.gateway_config.engines = spawn
    body = {"id": "e-9", "host": "gpu-09", "url": "http://gpu-09:8200", "base_model": "tiny", "engine": "sglang"}
    body |= {"state": "ready", "pool": "rack"}
    harness.client.post("/internal/gateway/engines", json=body, headers=harness.gateway_headers)
    config = harness.app.state.gateway_config.rebuild()
    assert config.engines["tiny"] == [
        {"url": "http://gpu-09:8200", "engine": "sglang", "pool": "rack", "state": "ready"}
    ]
    assert seen[-1]["tiny"][0]["url"] == "http://gpu-09:8200"
