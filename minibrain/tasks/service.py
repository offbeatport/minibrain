from collections.abc import Mapping, Sequence
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.artifacts import ArtifactStore
from minibrain.data.splits import DatasetVersionError, read_split
from minibrain.presets import Preset, preset, render
from minibrain.registry.files import dataset_version_location
from minibrain.registry.models import DatasetVersion, JudgeScore, Model, Version, VersionKind, VersionStatus
from minibrain.registry.service import ConflictError
from minibrain.tasks.contracts import (
    FREE_TEXT,
    MAX_LABELS,
    Contract,
    ContractError,
    breaking_changes,
    described,
    label_set,
    with_labels,
)
from minibrain.tasks.examples import Example, as_record
from minibrain.tasks.graders import Grader, GraderError, build, check_configs, grade, main_metric, metric_values
from minibrain.tasks.judge import judge_of
from minibrain.tasks.promotion import Decision, Live, Rule, decide
from minibrain.tasks.prompting import Prompting


class BreakingChangeError(ConflictError):
    pass


def preset_of(model: Model) -> Preset:
    return preset(model.preset)


def contract_of(model: Model) -> Contract:
    return Contract.from_dict(model.contract) if model.contract else FREE_TEXT


def version_contract(version: Version) -> Contract:
    return Contract.from_dict(version.contract) if version.contract else FREE_TEXT


def rule_of(model: Model) -> Rule:
    return Rule.from_dict(model.promotion)


def version_metric(version: Version) -> str | None:
    return main_metric(version.graders)


def held_out(version: Version) -> dict[str, float] | None:
    split = (version.metrics or {}).get("eval")
    return metric_values(split) if split and split.get("scores") else None


def held_out_score(version: Version) -> float | None:
    metric = version_metric(version)
    values = held_out(version)
    return None if metric is None or values is None else values.get(metric)


def live_version(model: Model) -> Version | None:
    if not model.deployed or model.current_version is None:
        return None
    return next((item for item in model.versions if item.number == model.current_version), None)


def decision(model: Model, version: Version) -> Decision:
    live = live_version(model)
    against = None if live is None or live.id == version.id else Live(live.number, held_out(live))
    return decide(rule_of(model), held_out(version), version_metric(version), against)


def latest_version_of(model: Model) -> Version | None:
    return max(model.versions, key=lambda item: item.number, default=None)


def data_labels(session: Session, store: ArtifactStore, dataset_version: DatasetVersion) -> list[str]:
    if dataset_version.labels:
        return list(dataset_version.labels)
    try:
        location = dataset_version_location(session, store, dataset_version)
        examples = [example for name in ("golden", "eval", "shots", "train") for example in read_split(location, name)]
    except DatasetVersionError:
        return []
    found = sorted({example.expected for example in examples})
    return found if len(found) <= MAX_LABELS else []


def contract_with_data(
    session: Session, store: ArtifactStore, model: Model, dataset_version: DatasetVersion | None
) -> Contract:
    current = contract_of(model)
    if not preset_of(model).labels_from_data:
        return current
    if dataset_version is None:
        if current.labels is None:
            raise ConflictError(f"{model.name} needs at least two labels: type them, or pick a dataset")
        return current
    labels = data_labels(session, store, dataset_version)
    if len(labels) < 2:
        raise ConflictError(
            f"{model.name} classifies into labels found in its data, and this dataset version has "
            f"{'one label' if len(labels) == 1 else 'no label set'}; it needs at least two, at most {MAX_LABELS}"
        )
    try:
        return with_labels(current, labels) if current.labels else label_set(labels)
    except ContractError as error:
        raise ConflictError(f"{error}: add labels or pick a dataset with at least two") from error


def checked_contract(model: Model, contract: Contract, breaking: bool) -> int:
    previous = latest_version_of(model)
    if previous is None:
        return 1
    if version_contract(previous) == contract:
        return previous.contract_number
    found = breaking_changes(version_contract(previous), contract)
    if found and not breaking and not model.breaking_confirmed:
        raise BreakingChangeError(
            f"This changes the contract apps use: {described(found)}. Confirm it as a breaking change to go on."
        )
    return previous.contract_number + 1


def checked_graders(configs: Sequence[dict[str, Any]], contract: Contract) -> list[dict[str, Any]]:
    try:
        check_configs(configs, contract)
    except GraderError as error:
        raise ConflictError(str(error)) from error
    return [dict(config) for config in configs]


def instructions_for(model: Model, contract: Contract, kind: VersionKind) -> str:
    chosen = preset_of(model)
    trained = kind == VersionKind.LORA
    if trained and chosen.trained_prompts != chosen.prompts:
        return chosen.instructions(contract, trained=True)
    if model.instructions:
        return render(model.instructions, contract)
    return chosen.instructions(contract, trained=trained)


def shots_of(session: Session, store: ArtifactStore, dataset_version: DatasetVersion | None) -> list[dict[str, Any]]:
    if dataset_version is None or not dataset_version.counts:
        return []
    return [as_record(shot) for shot in read_split(dataset_version_location(session, store, dataset_version), "shots")]


def next_version_number(model: Model) -> int:
    highest = max((version.number for version in model.versions), default=-1)
    model.last_version = max(highest, model.last_version) + 1
    return model.last_version


def new_version(
    session: Session,
    store: ArtifactStore,
    model: Model,
    kind: VersionKind,
    dataset_version: DatasetVersion | None,
    recipe: dict[str, Any] | None = None,
    breaking: bool = False,
) -> Version:
    contract = contract_with_data(session, store, model, dataset_version)
    number = checked_contract(model, contract, breaking)
    graders = checked_graders(model.graders or preset_of(model).default_graders(contract), contract)
    model.contract = contract.as_dict()
    model.breaking_confirmed = False
    model.graders = graders
    scored = dataset_version is not None and bool(dataset_version.counts)
    version = Version(
        model=model,
        dataset_version=dataset_version,
        number=next_version_number(model),
        kind=kind,
        status=VersionStatus.TRAINING if kind == VersionKind.LORA else VersionStatus.EVALUATING,
        recipe=dict(recipe or {}),
        contract=contract.as_dict(),
        contract_number=number,
        instructions=instructions_for(model, contract, kind),
        shots=[] if kind == VersionKind.LORA else shots_of(session, store, dataset_version),
        graders=graders,
    )
    if kind == VersionKind.PROMPT and not scored:
        version.status = VersionStatus.READY
    session.add(version)
    session.flush()
    return version


def prompting_of(version: Version) -> Prompting:
    return Prompting.from_dict(
        {
            "instructions": version.instructions,
            "contract": version.contract,
            "shots": version.shots,
            "trained": version.kind == VersionKind.LORA,
        }
    )


def judge_scores(session: Session, keys: Sequence[str]) -> dict[str, float]:
    if not keys:
        return {}
    found = session.scalars(select(JudgeScore).where(JudgeScore.key.in_(list(keys))))
    return {row.key: row.score for row in found}


def graders_of(version: Version, found: Mapping[str, float] | None = None) -> list[Grader]:
    contract = version_contract(version)
    return [build(config, contract, found) for config in version.graders]


def split_examples(session: Session, store: ArtifactStore, version: Version) -> dict[str, list[Example]]:
    if version.dataset_version is None:
        return {}
    location = dataset_version_location(session, store, version.dataset_version)
    return {name: read_split(location, name) for name in ("golden", "eval")}


def judge_keys(version: Version, examples: dict[str, list[Example]], answers: Mapping[str, Sequence[str]]) -> list[str]:
    judge = judge_of(graders_of(version))
    if judge is None:
        return []
    return [
        judge.key(answer, example)
        for name, rows in examples.items()
        for example, answer in zip(rows, answers.get(name, []), strict=True)
    ]


def graded(
    session: Session, store: ArtifactStore, version: Version, answers: Mapping[str, Sequence[str]]
) -> dict[str, Any]:
    examples = split_examples(session, store, version)
    found = judge_scores(session, judge_keys(version, examples, answers))
    graders = graders_of(version, found)
    contract = version_contract(version)
    return {name: grade(graders, contract, rows, list(answers.get(name, []))) for name, rows in examples.items()}
