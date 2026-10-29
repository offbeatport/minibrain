import re
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.base_models import base_model
from minibrain.data.snapshot import prompt_context
from minibrain.registry.models import Minibrain, Version, VersionKind, VersionStatus
from minibrain.registry.service import adapter_name, find_version
from minibrain.serve.backend import AdapterRef, CompletionRequest
from minibrain.tasks.classify import build_messages

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


def completion_request(target: Target, text: str, max_tokens: int) -> CompletionRequest:
    version = target.version
    labels, shots = prompt_context(version.snapshot.directory)
    adapter = None
    if version.kind == VersionKind.LORA and version.adapter_dir:
        adapter = AdapterRef(name=adapter_name(target.minibrain.slug, version.number), path=Path(version.adapter_dir))
    return CompletionRequest(
        base=base_model(target.minibrain.base_model),
        messages=build_messages(version.kind, text, labels, shots),
        adapter=adapter,
        max_tokens=max_tokens,
    )
