import json
import threading
import time
from collections.abc import Iterator
from typing import Any

from minibrain.base_models import BaseModelSpec
from minibrain.ml.completion import Completion
from minibrain.serve.backend import (
    AdapterNotSupportedError,
    CompletionRequest,
    Event,
    OutputFormatError,
    parsed,
    streamed,
)
from minibrain.serve.sampling import Sampling
from minibrain.serve.structured import Constraint, choice_grammar
from minibrain.serve.weights import gguf_path

CONTEXT_TOKENS = 4096
ARGUMENTS = {
    "temperature": "temperature",
    "top_p": "top_p",
    "top_k": "top_k",
    "min_p": "min_p",
    "presence_penalty": "presence_penalty",
    "frequency_penalty": "frequency_penalty",
    "repetition_penalty": "repeat_penalty",
    "seed": "seed",
}


def sampling_arguments(sampling: Sampling, stops: tuple[str, ...]) -> dict[str, Any]:
    found = {ARGUMENTS[name]: value for name, value in sampling.given().items() if name in ARGUMENTS}
    return found | {"stop": [*stops, *sampling.stop]}


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

    def render(self, model: Any, request: CompletionRequest) -> str:
        from transformers.utils.chat_template_utils import render_jinja_template

        template = model.metadata.get("tokenizer.chat_template")
        if not template:
            raise ValueError(f"{request.base.key} has no chat template in its GGUF metadata")
        eos = model.detokenize([model.token_eos()]).decode(errors="ignore")
        bos = model.detokenize([model.token_bos()]).decode(errors="ignore")
        rendered, _ = render_jinja_template(
            conversations=[request.template_messages()],
            tools=request.template_tools(),
            chat_template=template,
            add_generation_prompt=True,
            bos_token=bos,
            eos_token=eos,
            **request.template_kwargs(),
        )
        return rendered[0] + request.prefill()

    def complete(self, request: CompletionRequest) -> Completion:
        if request.adapter is not None:
            raise AdapterNotSupportedError("the llama.cpp engine serves GGUF base models without adapters")
        constrained = grammar(request.constraint)
        with self.lock:
            model = self.runtime(request.base)
            started = time.perf_counter()
            result = model.create_completion(
                self.render(model, request),
                max_tokens=request.max_tokens,
                grammar=constrained,
                **sampling_arguments(request.sampling, request.base.stop_tokens),
            )
        choice = result["choices"][0]
        usage = result.get("usage") or {}
        raw = Completion(
            text=str(choice.get("text") or ""),
            prompt_tokens=int(usage.get("prompt_tokens", 0)),
            completion_tokens=int(usage.get("completion_tokens", 0)),
            stopped=choice.get("finish_reason") == "stop",
            seconds=time.perf_counter() - started,
        )
        return parsed(request, raw)

    def stream(self, request: CompletionRequest) -> Iterator[Event]:
        if request.adapter is not None:
            raise AdapterNotSupportedError("the llama.cpp engine serves GGUF base models without adapters")
        constrained = grammar(request.constraint)
        with self.lock:
            model = self.runtime(request.base)
            yield from streamed(request, self.raw_stream(model, request, constrained))

    def raw_stream(self, model: Any, request: CompletionRequest, constrained: Any) -> Iterator[str | Completion]:
        prompt = self.render(model, request)
        started = time.perf_counter()
        text, finish, generated = "", None, 0
        for chunk in model.create_completion(
            prompt,
            max_tokens=request.max_tokens,
            grammar=constrained,
            stream=True,
            **sampling_arguments(request.sampling, request.base.stop_tokens),
        ):
            choice = chunk["choices"][0]
            piece = str(choice.get("text") or "")
            finish = choice.get("finish_reason") or finish
            generated += 1 if piece else 0
            text += piece
            if piece:
                yield piece
        yield Completion(
            text=text,
            prompt_tokens=len(model.tokenize(prompt.encode(), special=True)),
            completion_tokens=generated,
            stopped=finish == "stop",
            seconds=time.perf_counter() - started,
        )

    def status(self) -> list[dict[str, Any]]:
        return [{"base_model": key, "device": "llama.cpp", "adapters": []} for key in self.models]
