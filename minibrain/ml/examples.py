from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from minibrain.tasks.examples import Example, Message, assistant_turns
from minibrain.tasks.prompting import Prompting


@dataclass(frozen=True)
class Encoded:
    tokens: list[int]
    offset: int


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


def encode_turn(tokenizer: Any, prompt: list[Message], completion: Message, options: dict[str, Any]) -> Encoded:
    prompt_ids = token_ids(tokenizer.apply_chat_template(prompt, add_generation_prompt=True, **options))
    full = token_ids(tokenizer.apply_chat_template([*prompt, completion], **options))
    return Encoded(full, common_prefix(prompt_ids, full))


def encode(tokenizer: Any, prompting: Prompting, example: Example, template_kwargs: dict[str, Any]) -> list[Encoded]:
    options = {"tokenize": True, "return_dict": False, **template_kwargs}
    return [
        encode_turn(tokenizer, prompting.messages(prompt), completion, options)
        for prompt, completion in assistant_turns(example)
    ]


def encode_all(
    tokenizer: Any, prompting: Prompting, examples: Sequence[Example], template_kwargs: dict[str, Any]
) -> list[Encoded]:
    return [item for example in examples for item in encode(tokenizer, prompting, example, template_kwargs)]


def longest(encoded: Sequence[Encoded]) -> int:
    return max((len(item.tokens) for item in encoded), default=0)


def truncated(encoded: Sequence[Encoded], limit: int) -> int:
    return sum(1 for item in encoded if len(item.tokens) > limit)
