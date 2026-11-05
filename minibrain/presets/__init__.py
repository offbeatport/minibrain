import json
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any

import yaml

from minibrain.registry.service import NotFoundError
from minibrain.tasks.contracts import Contract
from minibrain.tasks.promotion import Rule

DIRECTORY = Path(__file__).resolve().parent
KINDS = ("text", "json", "labels")
LABEL_SET = "labels"
CHOOSE = "choose"


class PresetError(NotFoundError):
    pass


@dataclass(frozen=True)
class Planned:
    key: str
    label: str
    hint: str


PLANNED = (
    Planned("extract", "Extract", "Text → fields"),
    Planned("general", "General", "An assistant in your tone"),
    Planned("rewrite", "Rewrite", "Text → text in your style"),
    Planned("sql", "Text-to-SQL", "Question → SQL"),
)


def kind_of(contract: Contract) -> str:
    return LABEL_SET if contract.labels is not None else contract.kind


def render(template: str, contract: Contract) -> str:
    labels = "\n".join(contract.labels or ())
    schema = json.dumps(contract.schema, indent=2, ensure_ascii=False) if contract.schema else ""
    return template.replace("{labels}", labels).replace("{schema}", schema).strip()


def per_kind(value: Any) -> dict[str, Any]:
    if isinstance(value, dict) and value and set(value) <= set(KINDS):
        return dict(value)
    return dict.fromkeys(KINDS, value)


@dataclass(frozen=True)
class Preset:
    key: str
    label: str
    noun: str
    hint: str
    contract: str
    mapping: dict[str, str]
    prompts: dict[str, str]
    trained_prompts: dict[str, str]
    answer_tokens: int
    graders: dict[str, tuple[dict[str, Any], ...]]
    checks: tuple[str, ...]
    promotion: Rule
    view: str | None

    @property
    def labels_from_data(self) -> bool:
        return self.contract == LABEL_SET

    def instructions(self, contract: Contract, trained: bool = False) -> str:
        prompts = self.trained_prompts if trained else self.prompts
        template = prompts.get(kind_of(contract)) or self.prompts.get(kind_of(contract)) or ""
        return render(template, contract)

    def default_graders(self, contract: Contract) -> list[dict[str, Any]]:
        return [dict(config) for config in self.graders.get(kind_of(contract), ())]


def loaded(path: Path) -> Preset:
    data = yaml.safe_load(path.read_text())
    prompts = per_kind(data["prompt"])
    graders = per_kind(data.get("graders") or [])
    return Preset(
        key=str(data["key"]),
        label=str(data["label"]),
        noun=str(data["noun"]),
        hint=str(data["hint"]),
        contract=str(data["contract"]),
        mapping={str(key): str(value) for key, value in (data.get("mapping") or {}).items()},
        prompts={kind: str(text) for kind, text in prompts.items()},
        trained_prompts={kind: str(text) for kind, text in per_kind(data.get("trained_prompt") or prompts).items()},
        answer_tokens=int(data.get("answer_tokens", 256)),
        graders={kind: tuple(dict(item) for item in items) for kind, items in graders.items()},
        checks=tuple(str(check) for check in data.get("checks") or ()),
        promotion=Rule.from_dict(data.get("promotion")),
        view=data.get("view"),
    )


@cache
def presets() -> dict[str, Preset]:
    found = [loaded(path) for path in sorted(DIRECTORY.glob("*.yaml"))]
    return {item.key: item for item in found}


def preset(key: str) -> Preset:
    found = presets().get(key)
    if found is None:
        raise PresetError(f"no preset called {key}; pick one of {', '.join(presets())}")
    return found
