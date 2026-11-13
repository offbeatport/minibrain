from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from minibrain.api.access import builder, sees_rows, viewer
from minibrain.api.catalog import ensure_reachable
from minibrain.api.data import apply_mapping, dataset_preview_of, query_rows
from minibrain.api.deps import SessionDep, SettingsDep, StoreDep
from minibrain.api.reserved_names import reserved_info
from minibrain.api.schemas import (
    ContractChange,
    ContractCheck,
    ContractInfo,
    ContractUpdate,
    DatasetChoice,
    ExampleInfo,
    GraderConfig,
    GradersUpdate,
    InstructionsUpdate,
    JudgeUpdate,
    LabelDismissal,
    MappingUpdate,
    ModelAvatar,
    ModelCreate,
    ModelDetail,
    ModelDuplicate,
    ModelUpdate,
    NameSuggestion,
    PreviewResponse,
    PromotionInfo,
    QueryRequest,
    QueryResponse,
    RequestBodiesUpdate,
    RescoreResult,
    SampleDetail,
)
from minibrain.api.versions import audit_version, start_version
from minibrain.api.views import detail
from minibrain.artifacts import ArtifactStore
from minibrain.auth.identity import current_actor, current_role
from minibrain.auth.roles import Role, allows
from minibrain.base_models import DEFAULT_BASE_MODEL
from minibrain.data import splits
from minibrain.data.dataset_versions import cleanup, take_version, version_if_mapped
from minibrain.data.samples import find_sample, sample_dataset
from minibrain.data.shared import (
    aliases_for,
    dataset_of,
    get_dataset,
    sources_in,
    tables_of,
)
from minibrain.models.registry import ACTIVE_STATUSES, base_readiness, start_download
from minibrain.policy import LockedError, PolicyError, bodies_choice
from minibrain.presets import Preset, preset, preset_for
from minibrain.registry.files import dataset_version_location
from minibrain.registry.models import (
    AuditEvent,
    BaseModel,
    BaseModelStatus,
    CatalogModel,
    DatasetVersion,
    Model,
    TeardownKind,
    TeardownStatus,
    VersionKind,
    now,
)
from minibrain.registry.service import (
    ConflictError,
    check_rename,
    create_model,
    free_model_name,
    get_model,
    latest_dataset_version,
    preview_address,
    slugify,
)
from minibrain.settings import Settings
from minibrain.tags import merged_tags, user_tags
from minibrain.tasks.contracts import FREE_TEXT, Contract, ContractError, changes, json_contract, label_set
from minibrain.tasks.duplicate import copied_version, duplicate_model, source_version
from minibrain.tasks.judges import installed
from minibrain.tasks.promotion import Rule, RuleError
from minibrain.tasks.rescore import rescore
from minibrain.tasks.service import (
    contract_of,
    latest_version_of,
    model_graders,
    preset_of,
    version_contract,
    went_live,
)
from minibrain.teardown import cancel_stop, require_idle, undeploy_custom

router = APIRouter(prefix="/api/models")


def contract_from(info: ContractInfo | None) -> Contract:
    try:
        if info is None or info.kind == "text":
            return FREE_TEXT
        if info.labels is not None:
            return label_set(info.labels)
        return json_contract(info.json_schema)
    except ContractError as error:
        raise ConflictError(str(error)) from error


def starting_contract(chosen: Preset, body: ModelCreate) -> Contract:
    if chosen.free_text:
        if body.labels or (body.contract is not None and body.contract.kind != "text"):
            raise ConflictError(
                f"A {chosen.label} answers in free text: send preset classify for labels or custom for a JSON schema"
            )
        return FREE_TEXT
    if not chosen.labels_from_data:
        return contract_from(body.contract)
    labels = body.labels or (body.contract.labels if body.contract and body.contract.labels else [])
    if not labels:
        return FREE_TEXT
    try:
        return label_set(labels)
    except ContractError as error:
        raise ConflictError(str(error)) from error


def chosen_graders(configs: list[GraderConfig] | None) -> list[dict[str, Any]]:
    return [config.model_dump(exclude_none=True) for config in configs or []]


def rule_from(info: PromotionInfo | None, fallback: Rule) -> dict[str, Any]:
    if info is None:
        return fallback.as_dict()
    try:
        return Rule.from_dict(info.model_dump()).as_dict()
    except RuleError as error:
        raise ConflictError(str(error)) from error


def first_version(session: Session, settings: Settings, store: ArtifactStore, model: Model) -> None:
    dataset = model.dataset
    dataset_version = latest_dataset_version(model)
    if dataset is not None and dataset_version is None:
        dataset_version = version_if_mapped(session, settings, dataset)
    start_version(session, settings, store, model, VersionKind.PROMPT, dataset_version)


def require_base(session: Session, base: str) -> None:
    if base_readiness(session, base) == "missing":
        raise ConflictError(f"{base} is not a base model on this install")
    found = session.get(BaseModel, base)
    teardown = found.teardown if found is not None else None
    deleting = teardown is not None and teardown.kind == TeardownKind.DELETE
    if found is not None and deleting and teardown is not None and teardown.status == TeardownStatus.RUNNING:
        raise ConflictError(f"{found.name} is being deleted; pick another base")


def configured(session: Session, settings: Settings, store: ArtifactStore, body: ModelCreate, base: str) -> Model:
    chosen = preset(body.preset)
    require_base(session, base)
    model = create_model(session, body.name, body.preset, base, body.api_name)
    model.description = body.description.strip()
    model.tags = user_tags(body.tags)
    model.avatar = body.avatar.model_dump(exclude_none=True) if body.avatar is not None else None
    contract = starting_contract(chosen, body)
    model.contract = contract.as_dict() if contract != FREE_TEXT or not chosen.labels_from_data else {}
    model.instructions = (body.instructions or "").strip() or None
    model.graders = chosen_graders(body.graders)
    model.promotion = rule_from(body.promotion, chosen.promotion)
    model.dataset = get_dataset(session, body.dataset)
    session.add(AuditEvent(actor=current_actor(), action="model.create", target=model.slug, detail=created(model)))
    first_version(session, settings, store, model)
    return model


@router.post("", status_code=201, dependencies=[Depends(builder)], summary="Create a custom model")
def create(body: ModelCreate, session: SessionDep, settings: SettingsDep, store: StoreDep) -> ModelDetail:
    model = configured(session, settings, store, body, body.base_model or DEFAULT_BASE_MODEL)
    session.commit()
    return detail(settings, model)


def created(model: Model) -> dict[str, Any]:
    facts = {"name": model.name, "preset": model.preset, "base": model.base_model}
    return facts | {"avatar": model.avatar} if model.avatar else facts


@router.post("/{name}/duplicate", status_code=201, dependencies=[Depends(builder)], summary="Duplicate a custom model")
def duplicate(
    name: str, body: ModelDuplicate, session: SessionDep, settings: SettingsDep, store: StoreDep
) -> ModelDetail:
    source = get_model(session, name)
    require_idle(source.teardown, source.name)
    require_base(session, source.base_model)
    model = duplicate_model(session, source, body.name, body.api_name)
    version = source_version(source)
    facts = created(model) | {"source": source.slug, "version": version.number if version is not None else None}
    session.add(AuditEvent(actor=current_actor(), action="model.duplicate", target=model.slug, detail=facts))
    first_version(session, settings, store, model)
    if version is not None:
        copy = copied_version(session, model, source, version)
        audit_version(
            session, model, copy.number, "version.create", kind=str(copy.kind), duplicated_from=copy.duplicated_from
        )
    session.commit()
    return detail(settings, model)


@router.get(
    "/name",
    dependencies=[Depends(viewer)],
    description="A free name and the API name it gets; with name, the API name that name would get.",
    summary="Suggest a model name and its API name",
)
def default_name(
    session: SessionDep,
    preset_key: str = Query(default="general", alias="preset"),
    name: str | None = Query(default=None, max_length=80),
) -> NameSuggestion:
    chosen = name.strip() if name and name.strip() else free_model_name(session, preset(preset_key).noun)
    found = preview_address(session, slugify(chosen))
    reserved = reserved_info(found.reserved) if found.reserved is not None else None
    return NameSuggestion(name=chosen, api_name=found.address, reserved=reserved)


def update_custom(session: Session, settings: Settings, model: Model, body: ModelUpdate) -> ModelDetail:
    before = {"name": model.name, "description": model.description, "tags": list(model.tags)}
    if body.name is not None:
        check_rename(session, model.name, body.name)
        model.name = body.name.strip()
    if body.description is not None:
        model.description = body.description.strip()
    if body.tags is not None:
        model.tags = merged_tags(model.tags, body.tags)
    audit_update(session, model, before)
    model.updated_at = now()
    session.commit()
    return detail(settings, model)


def audit_update(session: Session, model: Model, before: dict[str, Any]) -> None:
    after = {"name": model.name, "description": model.description, "tags": list(model.tags)}
    changed = [field for field in after if after[field] != before[field]]
    if not changed:
        return
    facts = {
        "name": model.name,
        "from": {field: before[field] for field in changed},
        "to": {field: after[field] for field in changed},
    }
    session.add(AuditEvent(actor=current_actor(), action="model.update", target=model.slug, detail=facts))


@router.put("/{name}/avatar", dependencies=[Depends(builder)], summary="Change a custom model's avatar")
def change_avatar(name: str, body: ModelAvatar, session: SessionDep, settings: SettingsDep) -> ModelDetail:
    model = get_model(session, name)
    before = model.avatar
    after = body.model_dump(exclude_none=True)
    if after != before:
        model.avatar = after
        facts = {"name": model.name, "from": before, "to": after}
        session.add(AuditEvent(actor=current_actor(), action="model.avatar", target=model.slug, detail=facts))
        model.updated_at = now()
        session.commit()
    return detail(settings, model)


def read_custom(settings: Settings, model: Model) -> ModelDetail:
    found = detail(settings, model)
    if sees_rows() or found.dataset_version is None:
        return found
    checks = [check.model_copy(update={"examples": []}) for check in found.dataset_version.checks]
    return found.model_copy(update={"dataset_version": found.dataset_version.model_copy(update={"checks": checks})})


SAMPLE_FILE = "demo_travel_intents.jsonl"
SAMPLE_PRESET = "general"


def deploy_custom(session: Session, model: Model, deployed: bool) -> bool:
    if not deployed:
        return undeploy_custom(session, model, current_actor()) is not None
    cancel_stop(session, model.teardown, model.name)
    if not model.deployed:
        facts = {"name": model.name, "version": model.current_version}
        session.add(AuditEvent(actor=current_actor(), action="model.deploy", target=model.slug, detail=facts))
        model.deployed_base = model.base_model
    model.deployed = True
    model.updated_at = now()
    return False


LOCKED_BY = {
    "ui": "locked for every model under Settings, Security",
    "config file": "set for every model in minibrain.yaml",
    "environment": "set for every model by the server's environment",
}


@router.put(
    "/{name}/request-bodies", dependencies=[Depends(builder)], summary="Keep or drop request inputs and answers"
)
def keep_request_bodies(
    name: str, body: RequestBodiesUpdate, session: SessionDep, settings: SettingsDep
) -> ModelDetail:
    model = get_model(session, name)
    _, lock = bodies_choice(session, model.request_bodies)
    if lock is not None:
        raise LockedError(f"Keep request inputs and answers is {LOCKED_BY.get(lock, lock)}")
    if model.request_bodies != body.kept:
        facts = {"name": model.name, "from": model.request_bodies, "to": body.kept}
        session.add(AuditEvent(actor=current_actor(), action="model.request_bodies", target=model.slug, detail=facts))
    model.request_bodies = body.kept
    model.updated_at = now()
    session.commit()
    return detail(settings, model)


def fetch_sample_base(session: Session, settings: Settings, key: str) -> tuple[str, int | None]:
    entry = session.get(CatalogModel, key)
    if entry is None or not entry.variants:
        raise ConflictError(f"The sample needs {key}, which is missing from the model catalogue")
    model = session.get(BaseModel, key)
    if model is not None and model.status in (BaseModelStatus.AVAILABLE, *ACTIVE_STATUSES):
        return entry.name, None
    variant = entry.variants[0]
    try:
        if not allows(current_role(), Role.ADMIN):
            raise ConflictError("Ask an admin to add it from Discover first.")
        ensure_reachable(session, entry, variant)
        start_download(session, settings, entry, variant, current_actor())
    except (ConflictError, PolicyError) as error:
        raise ConflictError(f"The sample needs {entry.name}, which is not on this install. {error}") from error
    return entry.name, variant.size_bytes


def sample_body(session: Session, settings: Settings, store: ArtifactStore) -> ModelCreate:
    sample = find_sample(SAMPLE_FILE)
    dataset = sample_dataset(session, settings, store, SAMPLE_FILE)
    return ModelCreate(
        name=free_model_name(session, sample.name, numbered=False),
        description=sample.description,
        base_model=DEFAULT_BASE_MODEL,
        preset=SAMPLE_PRESET,
        dataset=dataset.slug,
    )


@router.post("/sample", status_code=201, dependencies=[Depends(builder)], summary="Create the sample model")
def create_sample(session: SessionDep, settings: SettingsDep, store: StoreDep) -> SampleDetail:
    base_name, download_bytes = fetch_sample_base(session, settings, DEFAULT_BASE_MODEL)
    body = sample_body(session, settings, store)
    model = configured(session, settings, store, body, DEFAULT_BASE_MODEL)
    session.commit()
    return SampleDetail(**detail(settings, model).model_dump(), base_name=base_name, download_bytes=download_bytes)


@router.put("/{name}/dataset", dependencies=[Depends(builder)], summary="Choose the dataset a custom model trains on")
def choose_dataset(name: str, body: DatasetChoice, session: SessionDep, settings: SettingsDep) -> ModelDetail:
    model = get_model(session, name)
    model.dataset = get_dataset(session, body.dataset) if body.dataset else None
    model.updated_at = now()
    session.commit()
    return detail(settings, model)


@router.put(
    "/{name}/mapping", dependencies=[Depends(builder)], summary="Change the mapping of a custom model's dataset"
)
def update_mapping(
    name: str, body: MappingUpdate, session: SessionDep, settings: SettingsDep, store: StoreDep
) -> ModelDetail:
    model = get_model(session, name)
    dataset = dataset_of(model)
    apply_mapping(session, settings, store, dataset, body)
    take_version(session, settings, dataset)
    cleanup(session, settings)
    session.commit()
    return detail(settings, model)


@router.post("/{name}/query", dependencies=[Depends(builder)], summary="Run SQL over a custom model's sources")
def query(name: str, body: QueryRequest, session: SessionDep, settings: SettingsDep, store: StoreDep) -> QueryResponse:
    dataset = dataset_of(get_model(session, name))
    sources = sources_in(session, body.sql, dataset.sources)
    return query_rows(tables_of(settings, store, sources), body.sql, aliases_for(dataset.sources))


@router.get("/{name}/preview", dependencies=[Depends(builder)], summary="Preview a custom model's training rows")
def preview(name: str, session: SessionDep, settings: SettingsDep, store: StoreDep) -> PreviewResponse:
    return dataset_preview_of(settings, store, dataset_of(get_model(session, name)))


@router.post(
    "/{name}/dataset-versions",
    status_code=201,
    dependencies=[Depends(builder)],
    summary="Build a dataset version for a custom model",
)
def build_dataset_version(name: str, session: SessionDep, settings: SettingsDep) -> ModelDetail:
    model = get_model(session, name)
    take_version(session, settings, dataset_of(model))
    cleanup(session, settings)
    session.commit()
    return detail(settings, model)


@router.get("/{name}/golden", dependencies=[Depends(builder)], summary="List a custom model's test set")
def golden(name: str, session: SessionDep, store: StoreDep) -> list[ExampleInfo]:
    current = latest_dataset_version(get_model(session, name))
    if current is None or not current.counts:
        return []
    examples = splits.read_split(dataset_version_location(session, store, current), "golden")
    return [ExampleInfo(input=example.input, expected=example.expected) for example in examples]


def contract_check(model: Model, contract: Contract) -> ContractCheck:
    newest = latest_version_of(model)
    if newest is None:
        return ContractCheck(changes=[], breaking=False, against=None)
    found = [ContractChange(**change.as_dict()) for change in changes(version_contract(newest), contract)]
    breaking = went_live(model) and any(item.breaking for item in found)
    return ContractCheck(changes=found, breaking=breaking, against=newest.contract_number)


@router.post("/{name}/contract/check", dependencies=[Depends(builder)], summary="Check what a contract change breaks")
def check_contract(name: str, body: ContractInfo, session: SessionDep) -> ContractCheck:
    return contract_check(get_model(session, name), contract_from(body))


def switch_preset(model: Model, contract: Contract) -> None:
    chosen = preset_for(preset_of(model), contract_of(model), contract)
    if chosen.key != model.preset:
        model.preset = chosen.key
        model.graders = []
        model.promotion = chosen.promotion.as_dict()


@router.put("/{name}/contract", dependencies=[Depends(builder)], summary="Change a custom model's contract")
def update_contract(name: str, body: ContractUpdate, session: SessionDep, settings: SettingsDep) -> ModelDetail:
    model = get_model(session, name)
    contract = contract_from(body.contract)
    found = contract_check(model, contract)
    if found.breaking and not body.breaking:
        raise ConflictError("This contract removes or renames what apps rely on; confirm it as a breaking change")
    before = {"from": contract_of(model).as_dict(), "preset_from": model.preset}
    switch_preset(model, contract)
    model_graders(session, model, contract)
    model.contract = contract.as_dict()
    model.breaking_confirmed = found.breaking
    model.updated_at = now()
    facts = {
        "name": model.name,
        "preset": model.preset,
        "breaking": found.breaking,
        "changes": [item.model_dump() for item in found.changes],
    }
    session.add(AuditEvent(actor=current_actor(), action="model.contract", target=name, detail=facts | before))
    session.commit()
    return detail(settings, model)


@router.put("/{name}/label-proposal/dismissal", dependencies=[Depends(builder)], summary="Dismiss proposed labels")
def dismiss_labels(name: str, body: LabelDismissal, session: SessionDep, settings: SettingsDep) -> ModelDetail:
    model = get_model(session, name)
    found = session.get(DatasetVersion, body.dataset_version_id)
    if found is None or model.dataset_id is None or found.dataset_id != model.dataset_id:
        raise ConflictError(f"dataset version {body.dataset_version_id} is not a version of {model.name}'s data")
    dismissed = model.labels_dismissed or []
    if found.id not in dismissed:
        model.labels_dismissed = [*dismissed, found.id]
        facts = {"name": model.name, "dataset_version": found.hash, "labels": len(found.labels)}
        session.add(AuditEvent(actor=current_actor(), action="model.labels_dismiss", target=name, detail=facts))
    model.updated_at = now()
    session.commit()
    return detail(settings, model)


@router.put("/{name}/graders", dependencies=[Depends(builder)], summary="Change a custom model's graders")
def update_graders(name: str, body: GradersUpdate, session: SessionDep, settings: SettingsDep) -> ModelDetail:
    model = get_model(session, name)
    configs = chosen_graders(body.graders)
    facts = {"name": model.name, "from": [item.get("name") for item in model.graders]}
    before = model.graders
    model.graders = configs
    try:
        model_graders(session, model, contract_of(model))
    except ConflictError:
        model.graders = before
        raise
    model.updated_at = now()
    facts["to"] = [item["name"] for item in configs]
    session.add(AuditEvent(actor=current_actor(), action="model.graders", target=name, detail=facts))
    session.commit()
    return detail(settings, model)


@router.post(
    "/{name}/rescore", dependencies=[Depends(builder)], summary="Score every version again with the current graders"
)
def rescore_versions(name: str, session: SessionDep, settings: SettingsDep) -> RescoreResult:
    model = get_model(session, name)
    jobs = rescore(session, settings, model)
    numbers = [job.version.number for job in jobs if job.version is not None]
    facts = {"name": model.name, "versions": numbers}
    session.add(AuditEvent(actor=current_actor(), action="model.rescore", target=name, detail=facts))
    session.commit()
    return RescoreResult(versions=numbers, jobs=[job.id for job in jobs])


@router.put("/{name}/promotion", dependencies=[Depends(builder)], summary="Change a custom model's promotion rule")
def update_promotion(name: str, body: PromotionInfo, session: SessionDep, settings: SettingsDep) -> ModelDetail:
    model = get_model(session, name)
    facts = {"name": model.name, "from": dict(model.promotion)}
    model.promotion = rule_from(body, Rule())
    model.updated_at = now()
    session.add(
        AuditEvent(actor=current_actor(), action="model.promotion", target=name, detail=facts | {"to": model.promotion})
    )
    session.commit()
    return detail(settings, model)


@router.put("/{name}/instructions", dependencies=[Depends(builder)], summary="Change a custom model's instructions")
def update_instructions(name: str, body: InstructionsUpdate, session: SessionDep, settings: SettingsDep) -> ModelDetail:
    model = get_model(session, name)
    model.instructions = body.instructions.strip() or None
    model.updated_at = now()
    session.add(
        AuditEvent(actor=current_actor(), action="model.instructions", target=name, detail={"name": model.name})
    )
    session.commit()
    return detail(settings, model)


@router.put("/{name}/judge", dependencies=[Depends(builder)], summary="Change a custom model's judge")
def update_judge(name: str, body: JudgeUpdate, session: SessionDep, settings: SettingsDep) -> ModelDetail:
    model = get_model(session, name)
    if body.model and not installed(session, body.model):
        raise ConflictError(f"{body.model} is not a base model on this install")
    facts = {"name": model.name, "from": model.judge_model, "to": body.model or None}
    model.judge_model = body.model or None
    model.updated_at = now()
    session.add(AuditEvent(actor=current_actor(), action="model.judge", target=name, detail=facts))
    session.commit()
    return detail(settings, model)
