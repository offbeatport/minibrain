from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from spikes.banking77.config import ADAPTER_NAME, ADAPTERS_DIR
from spikes.banking77.data import read_examples, read_labels
from spikes.banking77.prompts import Message, prompt_only_messages, trained_messages

MINIBRAIN = "banking77"
CURRENT = f"{MINIBRAIN}@1"


@dataclass(frozen=True)
class Version:
    name: str
    adapter: str | None
    build_messages: Callable[[str], list[Message]]


def load_versions() -> dict[str, Version]:
    labels = read_labels()
    shots = read_examples("shots")
    prompt_only = Version(f"{MINIBRAIN}@0", None, lambda text: prompt_only_messages(text, labels, shots))
    trained = Version(CURRENT, ADAPTER_NAME, trained_messages)
    return {version.name: version for version in (prompt_only, trained)}


def resolve(name: str, versions: dict[str, Version]) -> Version | None:
    return versions.get(CURRENT if name == MINIBRAIN else name)


def adapter_paths(versions: list[Version]) -> dict[str, Path]:
    paths = {version.adapter: ADAPTERS_DIR / version.adapter for version in versions if version.adapter}
    return {name: path for name, path in paths.items() if path.exists()}
