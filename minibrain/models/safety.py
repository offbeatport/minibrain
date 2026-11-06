from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.models.registry import spec_for
from minibrain.registry import settings_store
from minibrain.registry.models import BaseModel, BaseModelStatus, Model
from minibrain.registry.service import ConflictError
from minibrain.serve.dialects import detect_guard
from minibrain.settings import Settings

SETTING = "safety"
INHERIT = "inherit"
OFF = "none"


@dataclass(frozen=True)
class SafetyChoice:
    model: str | None
    answers: bool
    source: str

    def as_route(self) -> dict[str, Any] | None:
        return {"model": self.model, "answers": self.answers} if self.model else None


def guard_keys(session: Session) -> list[str]:
    available = select(BaseModel).where(BaseModel.status == BaseModelStatus.AVAILABLE).order_by(BaseModel.id)
    return [base.id for base in session.scalars(available) if detect_guard(base.repo, base.name)]


def guard_specs(session: Session, settings: Settings) -> dict[str, dict[str, Any]]:
    found: dict[str, dict[str, Any]] = {}
    for key in guard_keys(session):
        base = session.get(BaseModel, key)
        if base is not None:
            found[key] = spec_for(settings, base).as_dict()
    return found


def require_guard(session: Session, key: str) -> None:
    if key not in guard_keys(session):
        message = (
            f"{key} is not a safety model on this install; install Llama Guard, ShieldGemma, Qwen3Guard or "
            "gpt-oss-safeguard from Discover first"
        )
        raise ConflictError(message)


def install_safety(session: Session) -> SafetyChoice:
    value = settings_store.read(session, SETTING, {})
    found = value if isinstance(value, dict) else {}
    model = found.get("model")
    return SafetyChoice(str(model) if model else None, bool(found.get("answers")), "install")


def set_install_safety(session: Session, model: str | None, answers: bool) -> None:
    if model:
        require_guard(session, model)
    settings_store.write(session, SETTING, {"model": model or None, "answers": bool(answers)})


def model_safety(session: Session, model: Model) -> SafetyChoice:
    if model.safety is None:
        return install_safety(session)
    chosen = model.safety.get("model")
    return SafetyChoice(str(chosen) if chosen else None, bool(model.safety.get("answers")), "model")


def override_of(mode: str, model: str | None, answers: bool) -> dict[str, Any] | None:
    if mode == INHERIT:
        return None
    if mode == OFF:
        return {"model": None, "answers": False}
    if not model:
        raise ConflictError("pick the safety model this model uses")
    return {"model": model, "answers": answers}
