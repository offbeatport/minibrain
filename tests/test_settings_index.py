import re
from pathlib import Path

from minibrain.policy import FIELDS

INDEX = Path(__file__).resolve().parents[1] / "web" / "src" / "pages" / "settings" / "settingsIndex.ts"


def indexed_policies() -> list[str]:
    return re.findall(r'\bpolicy\(\s*"([a-z_]+)"', INDEX.read_text())


def test_every_policy_is_in_the_settings_search_index() -> None:
    assert sorted(indexed_policies()) == sorted(field.name for field in FIELDS)


def test_no_policy_is_indexed_twice() -> None:
    names = indexed_policies()
    assert len(names) == len(set(names))
