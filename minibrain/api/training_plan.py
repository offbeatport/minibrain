from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from minibrain.api.access import viewer
from minibrain.api.deps import LocalNodeDep, SessionDep, SettingsDep
from minibrain.api.schemas import (
    TrainFitInfo,
    TrainingDefaults,
    TrainingOptionInfo,
    TrainingPlanInfo,
    TrainingPlanQuery,
    TrainingSettings,
)
from minibrain.data.dataset_versions import chosen_dataset_version, require_splits
from minibrain.ml.planner import (
    REFERENCE_SEQ,
    Base,
    Machine,
    Option,
    Plan,
    PlanError,
    Settings,
    gigabytes,
    minimum,
    plan,
    validate,
)
from minibrain.models.hardware import NodeReport
from minibrain.models.train_facts import base_facts, catalogue_base, longest_example, trainer_machines
from minibrain.registry.compute import pools
from minibrain.registry.files import dataset_version_location, store_for
from minibrain.registry.models import CatalogModel, CatalogVariant, DatasetVersion, Model
from minibrain.registry.service import ConflictError, get_model
from minibrain.settings import Settings as InstallSettings
from minibrain.tasks.rebase import serve_only

router = APIRouter(prefix="/api", tags=["training"])
PlanLevel = Literal["fits", "insufficient", "unknown"]


def planner_settings(body: TrainingSettings) -> Settings:
    defaults = Settings()
    return Settings(
        strategy=body.strategy,
        checkpointing=body.checkpointing,
        micro_batch=body.micro_batch,
        seq_len=body.seq_len,
        rank=body.rank or defaults.rank,
        learning_rate=body.learning_rate or defaults.learning_rate,
        epochs=body.epochs or defaults.epochs,
        max_rows=body.max_rows or defaults.max_rows,
    )


def model_base(session: Session, settings: InstallSettings, model: Model) -> Base:
    return base_facts(session, settings, model.base_model)


def require_trainable(session: Session, settings: InstallSettings, model: Model) -> None:
    limit = serve_only(session, settings, model.base_model)
    if limit is not None:
        raise ConflictError(limit.reason)
    try:
        validate(model_base(session, settings, model), Settings())
    except PlanError as error:
        raise ConflictError(str(error)) from error


def training_plan(
    session: Session,
    settings: InstallSettings,
    node: NodeReport,
    model: Model,
    dataset_version: DatasetVersion,
    body: TrainingSettings,
) -> tuple[Plan, int]:
    require_splits(dataset_version)
    require_trainable(session, settings, model)
    chosen = planner_settings(body)
    location = dataset_version_location(session, store_for(settings), dataset_version)
    rows, longest = longest_example(location, chosen.max_rows)
    machines = trainer_machines(pools(session, node))
    try:
        return plan(model_base(session, settings, model), machines, chosen, longest, rows), longest
    except PlanError as error:
        raise ConflictError(str(error)) from error


def refuse(found: Plan) -> None:
    if found.refusal:
        raise ConflictError(found.refusal)


def option_info(option: Option) -> TrainingOptionInfo:
    return TrainingOptionInfo(
        strategy=option.strategy,
        label=option.label,
        checkpointing=option.checkpointing,
        micro_batch=option.micro_batch,
        grad_accum=option.grad_accum,
        device=option.device,
        precision=option.precision,
        optimizer=option.optimizer,
        peak_bytes=option.peak_bytes,
        available_bytes=option.available_bytes,
        fits=option.fits,
        supported=option.supported,
        reason=option.reason,
        parts=option.parts,
    )


def plan_level(found: Plan) -> PlanLevel:
    if found.refusal:
        return "insufficient"
    return "fits" if found.chosen is not None else "unknown"


def defaults_of(found: Plan) -> TrainingDefaults:
    settings = found.settings
    chosen = found.chosen
    return TrainingDefaults(
        strategy=chosen.strategy if chosen else None,
        checkpointing=chosen.checkpointing if chosen else None,
        micro_batch=chosen.micro_batch if chosen else None,
        seq_len=found.seq_len,
        rank=settings.rank,
        learning_rate=settings.learning_rate,
        epochs=settings.epochs,
        max_rows=settings.max_rows,
    )


def plan_info(found: Plan, default: Plan, longest: int) -> TrainingPlanInfo:
    return TrainingPlanInfo(
        level=plan_level(found),
        basis=found.basis,
        note=found.note,
        machine=found.machine.name if found.machine else None,
        memory_label=found.machine.memory_label if found.machine else None,
        chosen=option_info(found.chosen) if found.chosen else None,
        options=[option_info(option) for option in found.options],
        rows=found.rows,
        seq_len=found.seq_len,
        longest_tokens=longest,
        context=found.base.context,
        overrides=found.settings.overrides(),
        defaults=defaults_of(default),
    )


@router.get("/models/{slug}/training-plan", dependencies=[Depends(viewer)])
def get_training_plan(
    slug: str,
    query: Annotated[TrainingPlanQuery, Query()],
    session: SessionDep,
    settings: SettingsDep,
    node: LocalNodeDep,
) -> TrainingPlanInfo:
    model = get_model(session, slug)
    dataset_version = chosen_dataset_version(session, model, query.dataset_version_id)
    found, longest = training_plan(session, settings, node, model, dataset_version, query)
    default = found
    if found.settings.overrides():
        default, _ = training_plan(session, settings, node, model, dataset_version, TrainingSettings())
    return plan_info(found, default, longest)


def train_fit(entry: CatalogModel, variant: CatalogVariant, machines: list[Machine]) -> TrainFitInfo:
    base = catalogue_base(entry, variant)
    if base.quantized:
        return TrainFitInfo(
            level="unsupported",
            qlora_bytes=None,
            available_bytes=None,
            label=None,
            basis=f"{base.quantized.upper()} weights can be served but not fine-tuned.",
        )
    known = [machine for machine in machines if machine.available_bytes]
    smallest = minimum(base, next((machine for machine in known if machine.quantizes), None))
    need = (
        f"Needs about {gigabytes(smallest.peak_bytes)} to train with {smallest.label}, "
        f"one {REFERENCE_SEQ}-token row at a time."
    )
    if not known:
        return TrainFitInfo(
            level="unknown",
            qlora_bytes=smallest.peak_bytes,
            available_bytes=None,
            label=None,
            basis=f"{need} No machine that trains in this pool has reported its memory yet.",
        )
    found = plan(base, known, Settings(), REFERENCE_SEQ, Settings().max_rows)
    if found.chosen is None:
        return TrainFitInfo(
            level="insufficient",
            qlora_bytes=smallest.peak_bytes,
            available_bytes=found.machine.available_bytes if found.machine else None,
            label=None,
            basis=found.basis,
        )
    return TrainFitInfo(
        level="fits",
        qlora_bytes=smallest.peak_bytes,
        available_bytes=found.chosen.available_bytes,
        label=found.chosen.label,
        basis=f"{need} {found.machine.name if found.machine else 'This pool'} trains it: {found.basis}.",
    )
