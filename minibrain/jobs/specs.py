from typing import Any

from sqlalchemy.orm import Session

from minibrain.models.registry import resolve_spec
from minibrain.models.train_facts import base_facts
from minibrain.models.usage import touch
from minibrain.presets import preset
from minibrain.recipes import DEFAULT_RECIPE
from minibrain.registry.files import MissingArtifactError, ref
from minibrain.registry.models import Version
from minibrain.settings import Settings
from minibrain.tasks.graders import Judge
from minibrain.tasks.judge import Item
from minibrain.tasks.service import prompting_of


def dataset_version_ref(session: Session, version: Version) -> dict[str, Any]:
    if version.dataset_version is None:
        raise MissingArtifactError(f"{version.model.slug}@{version.number} has no dataset version")
    dataset_version = ref(session, version.dataset_version.artifact_id)
    if dataset_version is None:
        raise MissingArtifactError(f"dataset version {version.dataset_version.hash[:12]} has no artifact")
    return dataset_version


def base_spec(session: Session, settings: Settings, version: Version) -> dict[str, Any]:
    touch(session, version.model.base_model)
    return resolve_spec(session, settings, version.model.base_model).as_dict()


def train_params(session: Session, settings: Settings, version: Version) -> dict[str, Any]:
    return {
        "slug": version.model.slug,
        "number": version.number,
        "base_model": version.model.base_model,
        "base_spec": base_spec(session, settings, version),
        "dataset_version": dataset_version_ref(session, version),
        "recipe": DEFAULT_RECIPE | dict(version.recipe),
        "plan_base": base_facts(session, settings, version.model.base_model).as_dict(),
        "prompting": prompting_of(version).as_dict(),
    }


def eval_params(session: Session, settings: Settings, version: Version) -> dict[str, Any]:
    return {
        "slug": version.model.slug,
        "number": version.number,
        "base_model": version.model.base_model,
        "base_spec": base_spec(session, settings, version),
        "version_kind": version.kind,
        "dataset_version": dataset_version_ref(session, version),
        "adapter": ref(session, version.adapter_artifact_id),
        "prompting": prompting_of(version).as_dict(),
        "answer_tokens": preset(version.model.preset).answer_tokens,
    }


def judge_params(
    session: Session, settings: Settings, version: Version, judge: Judge, items: list[Item]
) -> dict[str, Any]:
    touch(session, judge.model)
    return {
        "slug": version.model.slug,
        "number": version.number,
        "base_model": judge.model,
        "base_spec": resolve_spec(session, settings, judge.model).as_dict(),
        "rubric": judge.rubric,
        "judge": judge.model,
        "judge_version": judge.model_version,
        "instructions": judge.instructions,
        "items": [item.as_dict() for item in items],
    }
