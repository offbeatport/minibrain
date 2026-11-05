from fastapi import APIRouter, Depends

from minibrain.api.access import builder, viewer
from minibrain.api.deps import SessionDep, SettingsDep, StoreDep
from minibrain.api.schemas import (
    GraderKindInfo,
    PlannedPresetInfo,
    PresetInfo,
    PresetsResponse,
    RecipeInfo,
    RecipeSample,
)
from minibrain.data.samples import load_recipe_sample
from minibrain.presets import PLANNED, Preset, presets
from minibrain.presets.recipes import Recipe, recipe, recipes
from minibrain.registry.service import latest_version
from minibrain.tasks.graders import CATALOGUE

router = APIRouter(prefix="/api", tags=["presets"])


def preset_info(item: Preset) -> PresetInfo:
    return PresetInfo.model_validate(
        {
            "key": item.key,
            "label": item.label,
            "noun": item.noun,
            "hint": item.hint,
            "contract": item.contract,
            "mapping": item.mapping,
            "prompts": item.prompts,
            "graders": {kind: list(configs) for kind, configs in item.graders.items()},
            "checks": list(item.checks),
            "promotion": item.promotion.as_dict(),
            "view": item.view,
            "answer_tokens": item.answer_tokens,
        }
    )


def recipe_info(item: Recipe) -> RecipeInfo:
    return RecipeInfo.model_validate(
        {
            "key": item.key,
            "name": item.name,
            "preset": item.preset,
            "summary": item.summary,
            "base": item.base,
            "data": item.data,
            "mapping": item.mapping,
            "graders": list(item.graders),
            "promotion": item.promotion.as_dict(),
            "contract": item.contract,
            "instructions": item.instructions,
            "readme": item.readme,
        }
    )


@router.get("/presets", dependencies=[Depends(viewer)])
def list_presets() -> PresetsResponse:
    return PresetsResponse(
        presets=[preset_info(item) for item in presets().values()],
        planned=[PlannedPresetInfo(key=item.key, label=item.label, hint=item.hint) for item in PLANNED],
        graders=[
            GraderKindInfo(
                name=info.name,
                label=info.label,
                description=info.description,
                contracts=list(info.contracts),
                metrics=list(info.metrics),
            )
            for info in CATALOGUE
        ],
    )


@router.get("/recipes", dependencies=[Depends(viewer)])
def list_recipes() -> list[RecipeInfo]:
    return [recipe_info(item) for item in recipes().values()]


@router.get("/recipes/{key}", dependencies=[Depends(viewer)])
def read_recipe(key: str) -> RecipeInfo:
    return recipe_info(recipe(key))


@router.post("/recipes/{key}/sample", status_code=201, dependencies=[Depends(builder)])
def load_sample(key: str, session: SessionDep, settings: SettingsDep, store: StoreDep) -> RecipeSample:
    dataset = load_recipe_sample(session, settings, store, recipe(key))
    session.commit()
    latest = latest_version(dataset)
    return RecipeSample(
        dataset=dataset.slug,
        dataset_name=dataset.name,
        rows=latest.rows if latest is not None else 0,
        labels=list(latest.labels) if latest is not None else [],
    )
