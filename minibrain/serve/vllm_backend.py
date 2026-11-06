import os
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

from minibrain.base_models import BaseModelSpec
from minibrain.serve.backend import CompletionRequest
from minibrain.serve.openai_server import (
    MAX_LORA_RANK,
    MAX_LORAS_PER_BATCH,
    STARTUP_SECONDS,
    Command,
    OpenAIServerBackend,
)
from minibrain.serve.select import vllm_python
from minibrain.serve.weights import local_dir


def launch_command(spec: BaseModelSpec, port: int) -> list[str]:
    return [
        vllm_python() or sys.executable,
        "-m",
        "vllm.entrypoints.openai.api_server",
        "--model",
        str(local_dir(spec)),
        "--served-model-name",
        spec.key,
        "--host",
        "127.0.0.1",
        "--port",
        str(port),
        "--enable-lora",
        "--max-lora-rank",
        str(MAX_LORA_RANK),
        "--max-loras",
        str(MAX_LORAS_PER_BATCH),
    ]


class VllmBackend(OpenAIServerBackend):
    engine = "vLLM"
    device = "vllm"

    def __init__(
        self,
        materialize: Callable[[dict[str, Any]], Path],
        command: Command = launch_command,
        startup_seconds: float = STARTUP_SECONDS,
    ) -> None:
        super().__init__(materialize, command, startup_seconds)

    def environment(self) -> dict[str, str]:
        return dict(os.environ) | {"VLLM_ALLOW_RUNTIME_LORA_UPDATING": "True"}

    def load_path(self) -> str:
        return "/v1/load_lora_adapter"

    def unload_path(self) -> str:
        return "/v1/unload_lora_adapter"

    def constraint_fields(self, request: CompletionRequest) -> dict[str, Any]:
        constraint = request.constraint
        if constraint is None:
            return {}
        if constraint.choices:
            return {"structured_outputs": {"choice": list(constraint.choices)}}
        json_schema = {"name": "response", "schema": constraint.json_schema, "strict": True}
        return {"response_format": {"type": "json_schema", "json_schema": json_schema}}

    def adapter_fields(self, request: CompletionRequest) -> dict[str, Any]:
        return {"model": request.adapter.name} if request.adapter else {}
