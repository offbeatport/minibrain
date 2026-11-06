import json
import sys
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, cast

import pytest
import torch
from fastapi.testclient import TestClient
from transformers import GenerationConfig

from minibrain.base_models import QWEN3_0_6B, base_model
from minibrain.ml.completion import Completion
from minibrain.ml.runtime import CountPenalty, sampled_config
from minibrain.serve.backend import AdapterRef, CompletionRequest
from minibrain.serve.engine import create_engine_app
from minibrain.serve.engines import EngineBackend
from minibrain.serve.llamacpp_backend import sampling_arguments
from minibrain.serve.mlx_backend import model_defaults
from minibrain.serve.sampling import GREEDY_SAMPLING, Sampling, UnsupportedParameterError, stopped_at
from minibrain.serve.sglang_backend import SglangBackend
from minibrain.serve.vllm_backend import VllmBackend
from tests.conftest import FakeBackend, Harness
from tests.test_flow import add_key
from tests.test_gateway import CHAT, servable
from tests.test_keys import BASE, headers, two_models

CHOSEN = Sampling(
    temperature=0.7,
    top_p=0.9,
    top_k=40,
    min_p=0.05,
    presence_penalty=0.5,
    frequency_penalty=-0.5,
    repetition_penalty=1.1,
    seed=7,
    stop=("###", "END"),
)
SAMPLED = CHOSEN.given()
MESSAGES = [{"role": "user", "content": "hello"}]


def chat(harness: Harness, auth: dict[str, str], **extra: Any) -> Any:
    return harness.client.post("/v1/chat/completions", headers=auth, json=CHAT | extra)


@dataclass
class Refusing(FakeBackend):
    def complete(self, request: CompletionRequest) -> Completion:
        self.requests.append(request)
        if request.sampling.min_p is not None:
            raise UnsupportedParameterError("min_p", "the test engine cannot honour min_p; leave it unset")
        return super().complete(request)


def test_every_sampling_parameter_reaches_the_backend(harness: Harness) -> None:
    auth = servable(harness)
    assert chat(harness, auth, **SAMPLED, max_completion_tokens=12, max_tokens=30).status_code == 200
    sent = harness.backend.requests[-1]
    assert sent.sampling == CHOSEN
    assert sent.max_tokens == 12
    assert chat(harness, auth, stop="###").status_code == 200
    assert harness.backend.requests[-1].sampling.stop == ("###",)


def test_unset_means_the_model_default_and_custom_models_stay_greedy(harness: Harness, tmp_path: Path) -> None:
    two_models(harness, tmp_path)
    auth = headers(add_key(harness, ("custom", "support-triage"), BASE))
    assert chat(harness, auth).status_code == 200
    custom = harness.backend.requests[-1]
    assert (custom.sampling, custom.max_tokens) == (GREEDY_SAMPLING, None)
    assert chat(harness, auth, model="base-one").status_code == 200
    assert harness.backend.requests[-1].sampling == Sampling()
    assert chat(harness, auth, model="base-one", temperature=1.2).status_code == 200
    assert harness.backend.requests[-1].sampling == Sampling(temperature=1.2)


@pytest.mark.parametrize(
    ("extra", "param"),
    [
        ({"temperature": 2.5}, "temperature"),
        ({"top_p": 0}, "top_p"),
        ({"top_k": 0}, "top_k"),
        ({"min_p": 1.5}, "min_p"),
        ({"presence_penalty": -3}, "presence_penalty"),
        ({"frequency_penalty": 2.1}, "frequency_penalty"),
        ({"repetition_penalty": 0}, "repetition_penalty"),
        ({"max_tokens": 0}, "max_tokens"),
        ({"n": 2}, "n"),
        ({"stop": ["a", "b", "c", "d", "e"]}, "stop"),
        ({"stop": [""]}, "stop"),
        ({"logprobs": True}, "logprobs"),
    ],
)
def test_out_of_range_parameters_are_openai_400s(harness: Harness, extra: dict[str, Any], param: str) -> None:
    auth = servable(harness)
    reply = chat(harness, auth, **extra)
    assert reply.status_code == 400, reply.text
    error = reply.json()["error"]
    assert (error["type"], error["param"]) == ("invalid_request_error", param)
    assert harness.backend.requests == []


def test_an_engine_that_cannot_honour_a_parameter_says_which(harness: Harness, tmp_path: Path) -> None:
    auth = servable(harness)
    app = create_engine_app(
        base_model("qwen3-0.6b"), "http://main", "t", tmp_path / "engine", backend=Refusing(), http=harness.client
    )
    with TestClient(app) as engine:
        harness.app.state.backend = EngineBackend(
            lambda: {"qwen3-0.6b": [{"url": "http://testserver", "state": "ready"}]}, http=engine
        )
        assert chat(harness, auth, top_k=5).status_code == 200
        refused = chat(harness, auth, min_p=0.1)
    assert refused.status_code == 400
    error = refused.json()["error"]
    assert (error["param"], error["code"]) == ("min_p", "unsupported_parameter")
    assert "cannot honour min_p" in error["message"]


def test_the_engine_protocol_carries_sampling_and_an_open_budget(harness: Harness, tmp_path: Path) -> None:
    fake = FakeBackend()
    app = create_engine_app(
        base_model("qwen3-0.6b"), "http://main", "t", tmp_path / "e", backend=fake, http=harness.client
    )
    with TestClient(app) as engine:
        backend = EngineBackend(lambda: {"qwen3-0.6b": [{"url": "http://testserver", "state": "ready"}]}, http=engine)
        sampling = Sampling(temperature=0.3, stop=("x",), seed=1)
        backend.complete(CompletionRequest(base_model("qwen3-0.6b"), MESSAGES, None, None, sampling=sampling))
    assert (fake.requests[-1].sampling, fake.requests[-1].max_tokens) == (sampling, None)


def logged_bodies(log: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in log.read_text().splitlines()]


def server_command(log: Path) -> Any:
    script = Path(__file__).parent / "fake_sglang.py"
    return lambda _spec, port: [sys.executable, str(script), "--port", str(port), "--log", str(log)]


def test_sglang_and_vllm_receive_only_what_was_set(tmp_path: Path) -> None:
    for kind in (SglangBackend, VllmBackend):
        log = tmp_path / f"{kind.__name__}.jsonl"
        backend = kind(lambda _artifact: tmp_path, command=server_command(log), startup_seconds=30)
        sampling = replace(CHOSEN, stop=("###",))
        adapter = AdapterRef("support@2", {"id": "x"})
        try:
            backend.complete(CompletionRequest(QWEN3_0_6B, MESSAGES, None, None))
            tuned = backend.complete(CompletionRequest(QWEN3_0_6B, MESSAGES, adapter, 16, sampling=sampling))
        finally:
            backend.close()
        assert tuned.text == "support@2:hello"
        calls = logged_bodies(log)
        chats = [call["body"] for call in calls if call["path"] == "/v1/chat/completions"]
        assert "temperature" not in chats[0] and "max_tokens" not in chats[0]
        assert chats[0]["stop"] == list(QWEN3_0_6B.stop_tokens)
        assert {key: chats[1][key] for key in SAMPLED if key != "stop"} == {
            key: value for key, value in SAMPLED.items() if key != "stop"
        }
        assert chats[1]["stop"] == [*QWEN3_0_6B.stop_tokens, "###"] and chats[1]["max_tokens"] == 16
        loads = [call["path"] for call in calls if "load_lora_adapter" in call["path"]]
        assert loads == (["/load_lora_adapter"] if kind is SglangBackend else ["/v1/load_lora_adapter"])


def test_transformers_samples_from_the_model_defaults_unless_told_otherwise() -> None:
    model = GenerationConfig(do_sample=True, temperature=0.6, top_p=0.95, top_k=20)
    assert sampled_config(model, None).do_sample is False
    default = sampled_config(model, Sampling())
    assert (default.do_sample, default.temperature, default.top_k) == (True, 0.6, 20)
    greedy = sampled_config(model, GREEDY_SAMPLING)
    assert greedy.do_sample is False
    chosen = sampled_config(model, Sampling(temperature=1.1, min_p=0.1, repetition_penalty=1.2, stop=("END",)))
    assert (chosen.do_sample, chosen.temperature, chosen.min_p, chosen.repetition_penalty) == (True, 1.1, 0.1, 1.2)
    assert chosen.stop_strings == ["END"]
    assert model.temperature == 0.6


def test_presence_and_frequency_penalties_lower_seen_tokens() -> None:
    penalty = CountPenalty(prompt_length=2, presence=0.5, frequency=1.0)
    tokens = cast(torch.LongTensor, torch.tensor([[9, 9, 1, 1, 2]]))
    scores = penalty(tokens, cast(torch.FloatTensor, torch.zeros((1, 4))))
    assert scores.tolist() == [[0.0, -2.5, -1.5, 0.0]]


def test_llama_cpp_and_mlx_map_the_parameters_to_their_own_names(tmp_path: Path) -> None:
    arguments = sampling_arguments(replace(CHOSEN, stop=("###",)), ("<|im_end|>",))
    assert arguments["repeat_penalty"] == 1.1 and arguments["stop"] == ["<|im_end|>", "###"]
    assert arguments["temperature"] == 0.7 and arguments["seed"] == 7 and "repetition_penalty" not in arguments
    assert sampling_arguments(Sampling(), ()) == {"stop": []}
    assert model_defaults(tmp_path) == GREEDY_SAMPLING
    (tmp_path / "generation_config.json").write_text(json.dumps({"do_sample": True, "temperature": 0.6, "top_k": 20}))
    assert model_defaults(tmp_path) == Sampling(temperature=0.6, top_k=20)
    assert Sampling(top_p=0.5).over(model_defaults(tmp_path)) == Sampling(temperature=0.6, top_p=0.5, top_k=20)
    assert stopped_at("abc###def END", ("END", "###")) == 3


def test_engines_refuse_parameters_they_cannot_honour() -> None:
    with pytest.raises(UnsupportedParameterError, match="cannot honour min_p"):
        Sampling(min_p=0.1).refuse_beyond({"temperature"}, "MLX")
    Sampling(temperature=0.1).refuse_beyond({"temperature"}, "MLX")
