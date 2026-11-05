import re
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.registry.models import Model, Version, VersionStatus
from minibrain.registry.service import find_version

MODEL_NAME = re.compile(r"^(?P<slug>[a-z0-9-]+)(?:@(?P<number>\d+))?$")


@dataclass(frozen=True)
class Target:
    model: Model
    version: Version

    @property
    def name(self) -> str:
        return f"{self.model.slug}@{self.version.number}"


def ready_version(model: Model, number: int | None) -> Version | None:
    if number is None:
        return None
    version = find_version(model, number)
    return version if version is not None and version.status == VersionStatus.READY else None


def target_for(model: Model, number: int | None) -> Target | None:
    version = ready_version(model, model.current_version if number is None else number)
    return Target(model, version) if version is not None else None


def resolve(session: Session, name: str) -> Target | None:
    match = MODEL_NAME.match(name)
    if match is None:
        return None
    model = session.scalar(select(Model).where(Model.slug == match["slug"]))
    if model is None:
        return None
    return target_for(model, int(match["number"]) if match["number"] else None)


def model_names(model: Model) -> list[str]:
    ready = sorted(version.number for version in model.versions if version.status == VersionStatus.READY)
    names = [model.slug] if model.deployed else []
    return names + [f"{model.slug}@{number}" for number in ready]
