from dataclasses import dataclass, field
from functools import cache
from pathlib import Path
from typing import Any

import yaml

from minibrain.presets import PresetError, preset
from minibrain.registry.service import NotFoundError
from minibrain.settings import REPO_ROOT
from minibrain.tasks.promotion import Rule

RECIPE_FILE = "minibrain.yaml"
README = "README.md"
MAPPING_KEYS = frozenset({"user", "assistant", "messages"})


class RecipeError(ValueError):
    pass


@dataclass(frozen=True)
class Recipe:
    key: str
    name: str
    preset: str
    summary: str
    base: str | None
    data: str
    mapping: dict[str, str]
    graders: tuple[dict[str, Any], ...]
    promotion: Rule
    readme: str
    directory: Path
    contract: dict[str, Any] | None = None
    instructions: str | None = None
    labels: tuple[str, ...] = field(default_factory=tuple)

    def data_path(self) -> Path:
        return self.directory / self.data


def recipes_dir() -> Path:
    packaged = Path(__file__).resolve().parent.parent / "bundled" / "recipes"
    return packaged if packaged.is_dir() else REPO_ROOT / "recipes"


def checked_mapping(key: str, mapping: Any) -> dict[str, str]:
    if not isinstance(mapping, dict) or not mapping or not set(mapping) <= MAPPING_KEYS:
        raise RecipeError(f"{key}: mapping takes user and assistant templates, or a messages column")
    if "messages" not in mapping and not {"user", "assistant"} <= set(mapping):
        raise RecipeError(f"{key}: mapping needs both a user and an assistant template")
    return {str(name): str(value) for name, value in mapping.items()}


def loaded(directory: Path) -> Recipe:
    key = directory.name
    data = yaml.safe_load((directory / RECIPE_FILE).read_text()) or {}
    try:
        preset(str(data.get("preset")))
    except PresetError as error:
        raise RecipeError(f"{key}: {error}") from error
    sample = str(data.get("data") or "")
    if not sample or not (directory / sample).is_file():
        raise RecipeError(f"{key}: data names a file in the recipe folder")
    readme = directory / README
    return Recipe(
        key=key,
        name=str(data["name"]),
        preset=str(data["preset"]),
        summary=str(data.get("summary") or ""),
        base=data.get("base"),
        data=sample,
        mapping=checked_mapping(key, data.get("mapping")),
        graders=tuple(dict(item) for item in data.get("graders") or ()),
        promotion=Rule.from_dict(data.get("promotion")),
        readme=readme.read_text() if readme.is_file() else "",
        directory=directory,
        contract=data.get("contract"),
        instructions=data.get("instructions"),
        labels=tuple(str(label) for label in data.get("labels") or ()),
    )


@cache
def recipes(root: Path | None = None) -> dict[str, Recipe]:
    folder = root or recipes_dir()
    found = [loaded(path) for path in sorted(folder.iterdir()) if (path / RECIPE_FILE).is_file()]
    return {recipe.key: recipe for recipe in found}


def recipe(key: str) -> Recipe:
    found = recipes().get(key)
    if found is None:
        raise NotFoundError(f"no recipe called {key}")
    return found
