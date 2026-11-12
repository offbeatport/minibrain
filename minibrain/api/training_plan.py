from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.api.access import viewer
from minibrain.api.deps import LocalNodeDep, SessionDep, SettingsDep
from minibrain.api.schemas import (
    MachinePlanInfo,
    QueuedJobInfo,
    TrainFitInfo,
    TrainingDefaults,
    TrainingOptionInfo,
    TrainingPlanInfo,
    TrainingPlanQuery,
    TrainingQueueInfo,
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
from minibrain.registry.models import (
    ACTIVE_JOB_STATUSES,
    CatalogModel,
    CatalogVariant,
    DatasetVersion,
    Job,
    JobKind,
    JobStatus,
    Model,
)
from minibrain.registry.service import ConflictError, get_model
from minibrain.settings import Settings as InstallSettings
from minibrain.tasks.rebase import serve_only

router = APIRouter(prefix="/api", tags=["training"])
PlanLevel = Literal["fits", "insufficient", "unknown"]
QUEUE_SHOWN = 10
HELD_OUT_SPLIT = "eval"


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
        alpha=body.alpha,
        grad_accum=body.grad_accum,
        eval_every=body.eval_every,
        seed=defaults.seed if body.seed is None else body.seed,
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
        return plan(model_base(session, settings, model), machines, chosen, longest, rows, body.machine), longest
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
        alpha=settings.lora_alpha,
        grad_accum=chosen.grad_accum if chosen else None,
        eval_every=settings.eval_every,
        seed=settings.seed,
    )


def unreported(machine: Machine) -> str:
    return f"{machine.name} has not reported its {machine.memory_label} yet."


def machine_info(found: Plan, picked: Machine | None, held_out: int) -> MachinePlanInfo | None:
    machine = found.machine
    if machine is None:
        return None
    reason = None if found.chosen else found.refusal or unreported(machine)
    return MachinePlanInfo(
        name=machine.name,
        pool=machine.pool,
        kind=machine.kind,
        memory_label=machine.memory_label,
        available_bytes=machine.available_bytes,
        fits=found.chosen is not None,
        chosen=option_info(found.chosen) if found.chosen else None,
        smallest=option_info(found.smallest) if found.smallest else None,
        reason=reason,
        minutes=found.minutes(held_out),
        steps=found.steps,
        picked=picked is not None and machine.name == picked.name,
    )


def queue_info(session: Session) -> TrainingQueueInfo:
    active = list(
        session.scalars(
            select(Job).where(Job.kind == JobKind.TRAIN, Job.status.in_(ACTIVE_JOB_STATUSES)).order_by(Job.id)
        )
    )
    return TrainingQueueInfo(
        ahead=len(active),
        running=sum(1 for job in active if job.status == JobStatus.RUNNING),
        jobs=[
            QueuedJobInfo(
                job_id=job.id,
                model=job.model_slug,
                model_name=job.model_name,
                version=job.version_number,
                status=job.status,
                progress=job.progress,
            )
            for job in active[:QUEUE_SHOWN]
        ],
    )


def held_out_rows(dataset_version: DatasetVersion) -> int:
    return int((dataset_version.counts or {}).get(HELD_OUT_SPLIT, 0))


def plan_info(found: Plan, default: Plan, longest: int, held_out: int, queue: TrainingQueueInfo) -> TrainingPlanInfo:
    machines = [machine_info(item, found.machine, held_out) for item in found.machines]
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
        minutes=found.minutes(held_out),
        steps=found.steps,
        grad_accum=found.chosen.grad_accum if found.chosen else None,
        held_out_rows=held_out,
        machines=[item for item in machines if item is not None],
        queue=queue,
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
        plain = TrainingSettings(machine=query.machine)
        default, _ = training_plan(session, settings, node, model, dataset_version, plain)
    return plan_info(found, default, longest, held_out_rows(dataset_version), queue_info(session))


def train_fit(entry: CatalogModel, variant: CatalogVariant, machines: list[Machine]) -> TrainFitInfo:
    return base_train_fit(catalogue_base(entry, variant), machines)


def base_train_fit(base: Base, machines: list[Machine]) -> TrainFitInfo:
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
