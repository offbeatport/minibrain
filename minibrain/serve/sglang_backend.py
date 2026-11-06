import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

from minibrain.base_models import BaseModelSpec
from minibrain.serve.backend import CompletionRequest
from minibrain.serve.dialects import HARMONY, HERMES, LLAMA3, MISTRAL
from minibrain.serve.openai_server import (
    MAX_LORA_RANK,
    MAX_LORAS_PER_BATCH,
    STARTUP_SECONDS,
    Command,
    OpenAIServerBackend,
)
from minibrain.serve.select import sglang_python
from minibrain.serve.structured import choice_grammar
from minibrain.serve.weights import local_dir

TOOL_PARSERS = {HERMES: "qwen25", LLAMA3: "llama3", MISTRAL: "mistral", HARMONY: "gpt-oss"}


def parser_flags(spec: BaseModelSpec) -> list[str]:
    tools = TOOL_PARSERS.get(spec.tools or "")
    return ["--tool-call-parser", tools] if tools else []


def launch_command(spec: BaseModelSpec, port: int) -> list[str]:
    return [
        sglang_python() or sys.executable,
        "-m",
        "sglang.launch_server",
        "--model-path",
        str(local_dir(spec)),
        "--host",
        "127.0.0.1",
        "--port",
        str(port),
        "--enable-lora",
        "--max-lora-rank",
        str(MAX_LORA_RANK),
        "--lora-target-modules",
        "all",
        "--max-loras-per-batch",
        str(MAX_LORAS_PER_BATCH),
        *parser_flags(spec),
    ]


class SglangBackend(OpenAIServerBackend):
    engine = "SGLang"
    device = "sglang"

    def __init__(
        self,
        materialize: Callable[[dict[str, Any]], Path],
        command: Command = launch_command,
        startup_seconds: float = STARTUP_SECONDS,
    ) -> None:
        super().__init__(materialize, command, startup_seconds)

    def constraint_fields(self, request: CompletionRequest) -> dict[str, Any]:
        constraint = request.constraint
        if constraint is None:
            return {}
        if constraint.choices:
            return {"ebnf": choice_grammar(constraint.choices)}
        json_schema = {"name": "response", "schema": constraint.json_schema, "strict": True}
        return {"response_format": {"type": "json_schema", "json_schema": json_schema}}

    def adapter_fields(self, request: CompletionRequest) -> dict[str, Any]:
        return {"lora_path": request.adapter.name} if request.adapter else {}
