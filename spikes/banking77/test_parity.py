import pytest
from transformers import PreTrainedTokenizerBase

from spikes.banking77.data import Example
from spikes.banking77.inference import load_tokenizer
from spikes.banking77.prompts import prompt_only_messages, render_conversation, render_prompt, trained_messages

TEXT = "I am still waiting on my card?"
LABEL = "card_arrival"
EMPTY_THINK = "<|im_start|>assistant\n<think>\n\n</think>\n\n"


@pytest.fixture(scope="module")
def tokenizer() -> PreTrainedTokenizerBase:
    return load_tokenizer()


def conversation(tokenizer: PreTrainedTokenizerBase) -> str:
    return render_conversation(tokenizer, [*trained_messages(TEXT), {"role": "assistant", "content": LABEL}])


def test_training_text_continues_the_serving_prompt(tokenizer: PreTrainedTokenizerBase) -> None:
    prompt = render_prompt(tokenizer, trained_messages(TEXT))
    assert conversation(tokenizer).startswith(prompt + LABEL + "<|im_end|>")


def test_prompt_tokens_are_a_prefix_of_training_tokens(tokenizer: PreTrainedTokenizerBase) -> None:
    prompt_ids = tokenizer(render_prompt(tokenizer, trained_messages(TEXT)), add_special_tokens=False)["input_ids"]
    training_ids = tokenizer(conversation(tokenizer), add_special_tokens=False)["input_ids"]
    assert training_ids[: len(prompt_ids)] == prompt_ids


def test_serving_prompt_disables_thinking(tokenizer: PreTrainedTokenizerBase) -> None:
    assert render_prompt(tokenizer, trained_messages(TEXT)).endswith(EMPTY_THINK)


def test_few_shot_turns_render_without_think_blocks(tokenizer: PreTrainedTokenizerBase) -> None:
    shots = [Example("Where is my new card?", LABEL), Example("My card was stolen", "lost_or_stolen_card")]
    prompt = render_prompt(tokenizer, prompt_only_messages(TEXT, [LABEL, "lost_or_stolen_card"], shots))
    assert prompt.count("<think>") == 1
    assert prompt.endswith(EMPTY_THINK)
