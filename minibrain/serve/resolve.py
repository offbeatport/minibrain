import re
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.registry.models import Minibrain, Version, VersionStatus
from minibrain.registry.service import find_version

MODEL_NAME = re.compile(r"^(?P<slug>[a-z0-9-]+)(?:@(?P<number>\d+))?$")


@dataclass(frozen=True)
class Target:
    minibrain: Minibrain
    version: Version

    @property
    def name(self) -> str:
        return f"{self.minibrain.slug}@{self.version.number}"


def ready_version(minibrain: Minibrain, number: int | None) -> Version | None:
    if number is None:
        return None
    version = find_version(minibrain, number)
    return version if version is not None and version.status == VersionStatus.READY else None


def target_for(minibrain: Minibrain, number: int | None) -> Target | None:
    version = ready_version(minibrain, minibrain.current_version if number is None else number)
    return Target(minibrain, version) if version is not None else None


def resolve(session: Session, name: str) -> Target | None:
    match = MODEL_NAME.match(name)
    if match is None:
        return None
    minibrain = session.scalar(select(Minibrain).where(Minibrain.slug == match["slug"]))
    if minibrain is None:
        return None
    return target_for(minibrain, int(match["number"]) if match["number"] else None)


def model_names(minibrain: Minibrain) -> list[str]:
    ready = sorted(version.number for version in minibrain.versions if version.status == VersionStatus.READY)
    names = [minibrain.slug] if minibrain.current_version in ready else []
    return names + [f"{minibrain.slug}@{number}" for number in ready]
