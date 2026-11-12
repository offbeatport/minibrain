from fastapi import APIRouter, Depends

from minibrain.api.access import admin, viewer
from minibrain.api.deps import SessionDep
from minibrain.api.schemas import (
    GraderKindInfo,
    JudgeSetting,
    JudgeUpdate,
    PlannedPresetInfo,
    PresetInfo,
    PresetsResponse,
)
from minibrain.api.views import base_name
from minibrain.auth.identity import current_actor
from minibrain.presets import PLANNED, Preset, presets
from minibrain.registry.models import AuditEvent
from minibrain.tasks.graders import CATALOGUE
from minibrain.tasks.judges import install_judge, set_install_judge

router = APIRouter(prefix="/api")


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
            "rubric": item.rubric,
            "expected": item.expected,
            "checks": list(item.checks),
            "promotion": item.promotion.as_dict(),
            "view": item.view,
            "answer_tokens": item.answer_tokens,
        }
    )


@router.get("/presets", dependencies=[Depends(viewer)], summary="List model presets")
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


def judge_setting(session: SessionDep) -> JudgeSetting:
    found = install_judge(session)
    return JudgeSetting(model=found, name=base_name(session, found) if found else None)


@router.get("/settings/judge", dependencies=[Depends(viewer)], summary="Read the default judge")
def read_judge(session: SessionDep) -> JudgeSetting:
    return judge_setting(session)


@router.put("/settings/judge", dependencies=[Depends(admin)], summary="Change the default judge")
def update_judge(body: JudgeUpdate, session: SessionDep) -> JudgeSetting:
    before = install_judge(session)
    set_install_judge(session, body.model)
    facts = {"from": before, "to": body.model or None}
    session.add(AuditEvent(actor=current_actor(), action="settings.judge", target="judge", detail=facts))
    session.commit()
    return judge_setting(session)
