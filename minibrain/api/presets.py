from fastapi import APIRouter, Depends

from minibrain.api.access import viewer
from minibrain.api.schemas import GraderKindInfo, PlannedPresetInfo, PresetInfo, PresetsResponse
from minibrain.presets import PLANNED, Preset, presets
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
