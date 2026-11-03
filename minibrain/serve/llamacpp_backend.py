import json
import threading
import time
from typing import Any

from minibrain.base_models import BaseModelSpec
from minibrain.ml.completion import Completion
from minibrain.serve.backend import AdapterNotSupportedError, CompletionRequest, OutputFormatError
from minibrain.serve.structured import Constraint, choice_grammar
from minibrain.serve.weights import gguf_path

CONTEXT_TOKENS = 4096


def grammar(constraint: Constraint | None) -> Any:
    if constraint is None:
        return None
    from llama_cpp import LlamaGrammar

    try:
        if constraint.choices:
            return LlamaGrammar.from_string(choice_grammar(constraint.choices), verbose=False)
        return LlamaGrammar.from_json_schema(json.dumps(constraint.json_schema), verbose=False)
    except Exception as error:
        raise OutputFormatError(f"llama.cpp cannot turn it into a grammar ({error})") from error


class LlamaCppBackend:
    def __init__(self) -> None:
        self.models: dict[str, Any] = {}
        self.lock = threading.Lock()

    def load(self, spec: BaseModelSpec) -> None:
        self.runtime(spec)

    def runtime(self, spec: BaseModelSpec) -> Any:
        if spec.key not in self.models:
            from llama_cpp import Llama

            self.models[spec.key] = Llama(
                model_path=str(gguf_path(spec)), n_ctx=CONTEXT_TOKENS, n_gpu_layers=-1, verbose=False
            )
        return self.models[spec.key]

    def render(self, model: Any, spec: BaseModelSpec, messages: list[Any]) -> str:
        from llama_cpp.llama_chat_format import Jinja2ChatFormatter

        template = model.metadata.get("tokenizer.chat_template")
        if not template:
            raise ValueError(f"{spec.key} has no chat template in its GGUF metadata")
        eos = model.detokenize([model.token_eos()]).decode(errors="ignore")
        bos = model.detokenize([model.token_bos()]).decode(errors="ignore")
        return Jinja2ChatFormatter(template, eos, bos)(messages=messages, **spec.template_kwargs).prompt

    def complete(self, request: CompletionRequest) -> Completion:
        if request.adapter is not None:
            raise AdapterNotSupportedError("the llama.cpp engine serves GGUF base models without adapters")
        constrained = grammar(request.constraint)
        with self.lock:
            model = self.runtime(request.base)
            started = time.perf_counter()
            result = model.create_completion(
                self.render(model, request.base, request.messages),
                max_tokens=request.max_tokens,
                temperature=0.0,
                stop=list(request.base.stop_tokens),
                grammar=constrained,
            )
        choice = result["choices"][0]
        usage = result.get("usage") or {}
        return Completion(
            text=str(choice.get("text") or ""),
            prompt_tokens=int(usage.get("prompt_tokens", 0)),
            completion_tokens=int(usage.get("completion_tokens", 0)),
            stopped=choice.get("finish_reason") == "stop",
            seconds=time.perf_counter() - started,
        )

    def status(self) -> list[dict[str, Any]]:
        return [{"base_model": key, "device": "llama.cpp", "adapters": []} for key in self.models]
