from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from minibrain.data.snapshot import Example
from minibrain.tasks.classify import trained_messages

Message = dict[str, str]


@dataclass(frozen=True)
class Encoded:
    tokens: list[int]
    offset: int


def prompt_of(text: str) -> list[Message]:
    return trained_messages(text)


def completion_of(label: str) -> list[Message]:
    return [{"role": "assistant", "content": label}]


def token_ids(rendered: Any) -> list[int]:
    if isinstance(rendered, list) and all(isinstance(token, int) for token in rendered):
        return rendered
    raise TypeError(f"expected token ids, got {type(rendered).__name__}")


def common_prefix(left: Sequence[int], right: Sequence[int]) -> int:
    length = 0
    for first, second in zip(left, right, strict=False):
        if first != second:
            break
        length += 1
    return length


def encode(tokenizer: Any, example: Example, template_kwargs: dict[str, Any]) -> Encoded:
    prompt = prompt_of(example.input)
    options = {"tokenize": True, "return_dict": False, **template_kwargs}
    prompt_ids = token_ids(tokenizer.apply_chat_template(prompt, add_generation_prompt=True, **options))
    full = token_ids(tokenizer.apply_chat_template(prompt + completion_of(example.label), **options))
    return Encoded(full, common_prefix(prompt_ids, full))


def encode_all(tokenizer: Any, examples: Sequence[Example], template_kwargs: dict[str, Any]) -> list[Encoded]:
    return [encode(tokenizer, example, template_kwargs) for example in examples]


def longest(encoded: Sequence[Encoded]) -> int:
    return max((len(item.tokens) for item in encoded), default=0)


def truncated(encoded: Sequence[Encoded], limit: int) -> int:
    return sum(1 for item in encoded if len(item.tokens) > limit)
