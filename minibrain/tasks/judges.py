from dataclasses import dataclass
from typing import Any, Literal

from sqlalchemy.orm import Session

from minibrain.models.registry import base_hash, base_readiness
from minibrain.registry import settings_store
from minibrain.registry.models import Model
from minibrain.registry.service import ConflictError

SETTING = "judge"
JUDGE = "judge"

Source = Literal["model", "install", "base"]


@dataclass(frozen=True)
class JudgeChoice:
    model: str
    source: Source

    @property
    def configured(self) -> bool:
        return self.source != "base"


def installed(session: Session, key: str | None) -> bool:
    return bool(key) and base_readiness(session, str(key)) != "missing"


def install_judge(session: Session) -> str | None:
    value = settings_store.read(session, SETTING, {})
    found = value.get("model") if isinstance(value, dict) else None
    return str(found) if found else None


def set_install_judge(session: Session, key: str | None) -> None:
    if key and not installed(session, key):
        raise ConflictError(f"{key} is not a base model on this install")
    settings_store.write(session, SETTING, {"model": key or None})


def judge_choice(session: Session, model: Model) -> JudgeChoice:
    if installed(session, model.judge_model):
        return JudgeChoice(str(model.judge_model), "model")
    chosen = install_judge(session)
    if installed(session, chosen):
        return JudgeChoice(str(chosen), "install")
    return JudgeChoice(model.base_model, "base")


def pinned_judge(session: Session, config: dict[str, Any], choice: JudgeChoice) -> dict[str, Any]:
    item = dict(config)
    if item.get("name") != JUDGE:
        return item
    key = str(item.get("model") or choice.model)
    if not installed(session, key):
        raise ConflictError(f"the judge model {key} is not on this install")
    item["model"] = key
    item["model_version"] = base_hash(session, key) or key
    return item
