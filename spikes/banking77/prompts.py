from transformers import PreTrainedTokenizerBase

from spikes.banking77.data import Example

Message = dict[str, str]

TRAINED_SYSTEM = "Classify the customer's banking message. Answer with the intent label only."


def prompt_only_system(labels: list[str]) -> str:
    listing = "\n".join(labels)
    return (
        "Classify the customer's banking message into exactly one intent label from this list:\n"
        f"{listing}\n\nAnswer with the intent label only."
    )


def shot_turns(shots: list[Example]) -> list[Message]:
    turns: list[Message] = []
    for shot in shots:
        turns.append({"role": "user", "content": shot.text})
        turns.append({"role": "assistant", "content": shot.label})
    return turns


def prompt_only_messages(text: str, labels: list[str], shots: list[Example]) -> list[Message]:
    system = {"role": "system", "content": prompt_only_system(labels)}
    return [system, *shot_turns(shots), {"role": "user", "content": text}]


def trained_messages(text: str) -> list[Message]:
    return [{"role": "system", "content": TRAINED_SYSTEM}, {"role": "user", "content": text}]


def as_text(rendered: object) -> str:
    if not isinstance(rendered, str):
        raise TypeError(f"expected rendered text, got {type(rendered).__name__}")
    return rendered


def render_prompt(tokenizer: PreTrainedTokenizerBase, messages: list[Message]) -> str:
    rendered = tokenizer.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True, enable_thinking=False
    )
    return as_text(rendered)


def render_conversation(tokenizer: PreTrainedTokenizerBase, messages: list[Message]) -> str:
    return as_text(tokenizer.apply_chat_template(messages, tokenize=False, enable_thinking=False))


def parse_label(output: str, labels: set[str]) -> str | None:
    lines = output.strip().splitlines()
    candidate = lines[0].strip().strip("`'\".").lower() if lines else ""
    return candidate if candidate in labels else None
