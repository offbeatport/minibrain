from typing import Any

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy.orm import Session

from minibrain.api.access import builder, sees_rows, viewer
from minibrain.api.catalog import ensure_reachable
from minibrain.api.data import apply_mapping, dataset_preview_of, query_rows
from minibrain.api.deps import SessionDep, SettingsDep, StoreDep
from minibrain.api.models import model_row, wake_teardowns
from minibrain.api.schemas import (
    ContractChange,
    ContractCheck,
    ContractInfo,
    ContractUpdate,
    DatasetChoice,
    DeployRequest,
    ExampleInfo,
    GraderConfig,
    GradersUpdate,
    InstructionsUpdate,
    MappingUpdate,
    MinibrainCreate,
    MinibrainDetail,
    MinibrainSummary,
    ModelRow,
    ModelUpdate,
    NameSuggestion,
    PreviewResponse,
    PromotionInfo,
    QueryRequest,
    QueryResponse,
    RequestBodiesUpdate,
    SampleDetail,
)
from minibrain.api.versions import start_version
from minibrain.api.views import detail, summary
from minibrain.artifacts import ArtifactStore
from minibrain.auth.identity import current_actor, current_role
from minibrain.auth.roles import Role, allows
from minibrain.base_models import DEFAULT_BASE_MODEL
from minibrain.data import snapshot
from minibrain.data.samples import load_recipe_sample
from minibrain.data.shared import (
    aliases_for,
    dataset_of,
    get_dataset,
    sources_in,
    tables_of,
)
from minibrain.data.snapshots import cleanup, take_version, version_if_mapped
from minibrain.models.registry import ACTIVE_STATUSES, base_hash, base_readiness, start_download
from minibrain.policy import LockedError, PolicyError, bodies_choice
from minibrain.presets import Preset, preset
from minibrain.presets.recipes import Recipe, recipe
from minibrain.registry.files import snapshot_location
from minibrain.registry.models import AuditEvent, CatalogModel, Dataset, Minibrain, Model, ModelStatus, VersionKind, now
from minibrain.registry.service import (
    ConflictError,
    create_minibrain,
    free_model_name,
    get_minibrain,
    latest_snapshot,
    list_minibrains,
)
from minibrain.settings import Settings
from minibrain.tags import merged_tags, user_tags
from minibrain.tasks.contracts import FREE_TEXT, Contract, ContractError, changes, json_contract, label_set
from minibrain.tasks.promotion import Rule, RuleError
from minibrain.tasks.service import checked_graders, contract_of, latest_version_of, version_contract
from minibrain.teardown import cancel_stop, delete_custom, undeploy_custom

router = APIRouter(prefix="/api/minibrains", tags=["minibrains"])


@router.get("", dependencies=[Depends(viewer)])
def list_all(session: SessionDep) -> list[MinibrainSummary]:
    return [summary(minibrain) for minibrain in list_minibrains(session)]


def contract_from(info: ContractInfo | None) -> Contract:
    try:
        if info is None or info.kind == "text":
            return FREE_TEXT
        if info.labels is not None:
            return label_set(info.labels)
        return json_contract(info.json_schema)
    except ContractError as error:
        raise ConflictError(str(error)) from error


def starting_contract(chosen: Preset, body: MinibrainCreate) -> Contract:
    if not chosen.labels_from_data:
        return contract_from(body.contract)
    labels = body.labels or (body.contract.labels if body.contract and body.contract.labels else [])
    if not labels:
        return FREE_TEXT
    try:
        return label_set(labels)
    except ContractError as error:
        raise ConflictError(str(error)) from error


def pinned(session: Session, configs: list[GraderConfig]) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    for config in configs:
        item = config.model_dump(exclude_none=True)
        if item["name"] == "judge" and item.get("model"):
            if base_readiness(session, str(item["model"])) == "missing":
                raise ConflictError(f"the judge model {item['model']} is not on this install")
            item["model_version"] = base_hash(session, str(item["model"])) or str(item["model"])
        found.append(item)
    return found


def rule_from(info: PromotionInfo | None, fallback: Rule) -> dict[str, Any]:
    if info is None:
        return fallback.as_dict()
    try:
        return Rule.from_dict(info.model_dump()).as_dict()
    except RuleError as error:
        raise ConflictError(str(error)) from error


def first_version(session: Session, settings: Settings, store: ArtifactStore, minibrain: Minibrain) -> None:
    dataset = minibrain.dataset
    snapshot = latest_snapshot(minibrain)
    if dataset is not None and snapshot is None:
        snapshot = version_if_mapped(session, settings, dataset)
    start_version(session, settings, store, minibrain, VersionKind.PROMPT, snapshot)


def configured(
    session: Session, settings: Settings, store: ArtifactStore, body: MinibrainCreate, base: str
) -> Minibrain:
    chosen = preset(body.preset)
    if base_readiness(session, base) == "missing":
        raise ConflictError(f"{base} is not a base model on this install")
    minibrain = create_minibrain(session, body.name, body.preset, base)
    minibrain.description = body.description.strip()
    minibrain.tags = user_tags(body.tags)
    contract = starting_contract(chosen, body)
    minibrain.contract = contract.as_dict() if contract != FREE_TEXT or not chosen.labels_from_data else {}
    minibrain.instructions = (body.instructions or "").strip() or None
    minibrain.graders = pinned(session, body.graders) if body.graders else []
    minibrain.promotion = rule_from(body.promotion, chosen.promotion)
    if body.dataset:
        minibrain.dataset = get_dataset(session, body.dataset)
    first_version(session, settings, store, minibrain)
    return minibrain


@router.post("", status_code=201, dependencies=[Depends(builder)])
def create(body: MinibrainCreate, session: SessionDep, settings: SettingsDep, store: StoreDep) -> MinibrainDetail:
    minibrain = configured(session, settings, store, body, body.base_model or DEFAULT_BASE_MODEL)
    session.add(
        AuditEvent(actor=current_actor(), action="model.create", target=minibrain.slug, detail=created(minibrain))
    )
    session.commit()
    return detail(settings, minibrain)


def created(minibrain: Minibrain) -> dict[str, Any]:
    return {"name": minibrain.name, "preset": minibrain.preset, "base": minibrain.base_model}


@router.get("/name", dependencies=[Depends(viewer)])
def default_name(session: SessionDep, preset_key: str = Query(default="classify", alias="preset")) -> NameSuggestion:
    return NameSuggestion(name=free_model_name(session, preset(preset_key).noun))


@router.patch("/{slug}", dependencies=[Depends(builder)])
def update(slug: str, body: ModelUpdate, session: SessionDep, settings: SettingsDep) -> MinibrainDetail:
    minibrain = get_minibrain(session, slug)
    if body.name is not None:
        minibrain.name = body.name.strip()
    if body.description is not None:
        minibrain.description = body.description.strip()
    if body.tags is not None:
        minibrain.tags = merged_tags(minibrain.tags, body.tags)
    minibrain.updated_at = now()
    session.commit()
    return detail(settings, minibrain)


@router.get("/{slug}", dependencies=[Depends(viewer)])
def read(slug: str, session: SessionDep, settings: SettingsDep) -> MinibrainDetail:
    found = detail(settings, get_minibrain(session, slug))
    if sees_rows() or found.snapshot is None:
        return found
    checks = [check.model_copy(update={"examples": []}) for check in found.snapshot.checks]
    return found.model_copy(update={"snapshot": found.snapshot.model_copy(update={"checks": checks})})


@router.delete("/{slug}", status_code=202, dependencies=[Depends(builder)])
def delete(
    slug: str, request: Request, session: SessionDep, settings: SettingsDep, store: StoreDep, undeploy: bool = False
) -> ModelRow:
    delete_custom(session, get_minibrain(session, slug), current_actor(), undeploy=undeploy)
    session.commit()
    wake_teardowns(request)
    return model_row(request, session, settings, store, "custom", slug)


SAMPLE_RECIPE = "ticket-routing"


@router.post("/{slug}/deploy", dependencies=[Depends(builder)])
def deploy(
    slug: str, body: DeployRequest, request: Request, response: Response, session: SessionDep, settings: SettingsDep
) -> MinibrainDetail:
    minibrain = get_minibrain(session, slug)
    if not body.deployed:
        if undeploy_custom(session, minibrain, current_actor()) is not None:
            response.status_code = 202
        session.commit()
        wake_teardowns(request)
        return detail(settings, minibrain)
    cancel_stop(session, minibrain.teardown, minibrain.name)
    if not minibrain.deployed:
        facts = {"name": minibrain.name, "version": minibrain.current_version}
        session.add(AuditEvent(actor=current_actor(), action="model.deploy", target=minibrain.slug, detail=facts))
    minibrain.deployed = True
    minibrain.updated_at = now()
    session.commit()
    return detail(settings, minibrain)


LOCKED_BY = {
    "ui": "locked for every model under Settings, Security",
    "config file": "set for every model in minibrain.yaml",
    "environment": "set for every model by the server's environment",
}


@router.put("/{slug}/request-bodies", dependencies=[Depends(builder)])
def keep_request_bodies(
    slug: str, body: RequestBodiesUpdate, session: SessionDep, settings: SettingsDep
) -> MinibrainDetail:
    minibrain = get_minibrain(session, slug)
    _, lock = bodies_choice(session, minibrain.request_bodies)
    if lock is not None:
        raise LockedError(f"Keep request inputs and answers is {LOCKED_BY.get(lock, lock)}")
    if minibrain.request_bodies != body.kept:
        facts = {"name": minibrain.name, "from": minibrain.request_bodies, "to": body.kept}
        session.add(
            AuditEvent(actor=current_actor(), action="model.request_bodies", target=minibrain.slug, detail=facts)
        )
    minibrain.request_bodies = body.kept
    minibrain.updated_at = now()
    session.commit()
    return detail(settings, minibrain)


def fetch_sample_base(session: Session, settings: Settings, key: str) -> tuple[str, int | None]:
    entry = session.get(CatalogModel, key)
    if entry is None or not entry.variants:
        raise ConflictError(f"The sample needs {key}, which is missing from the model catalogue")
    model = session.get(Model, key)
    if model is not None and model.status in (ModelStatus.AVAILABLE, *ACTIVE_STATUSES):
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


def recipe_body(session: Session, settings: Settings, store: ArtifactStore, found: Recipe) -> MinibrainCreate:
    dataset: Dataset = load_recipe_sample(session, settings, store, found)
    return MinibrainCreate.model_validate(
        {
            "name": free_model_name(session, found.name, numbered=False),
            "description": found.summary,
            "base_model": found.base,
            "preset": found.preset,
            "labels": list(found.labels),
            "contract": found.contract,
            "instructions": found.instructions,
            "graders": list(found.graders) or None,
            "promotion": found.promotion.as_dict(),
            "dataset": dataset.slug,
        }
    )


@router.post("/sample", status_code=201, dependencies=[Depends(builder)])
def create_sample(session: SessionDep, settings: SettingsDep, store: StoreDep) -> SampleDetail:
    found = recipe(SAMPLE_RECIPE)
    base_name, download_bytes = fetch_sample_base(session, settings, found.base or DEFAULT_BASE_MODEL)
    body = recipe_body(session, settings, store, found)
    minibrain = configured(session, settings, store, body, body.base_model or DEFAULT_BASE_MODEL)
    session.add(
        AuditEvent(actor=current_actor(), action="model.create", target=minibrain.slug, detail=created(minibrain))
    )
    session.commit()
    return SampleDetail(**detail(settings, minibrain).model_dump(), base_name=base_name, download_bytes=download_bytes)


@router.put("/{slug}/dataset", dependencies=[Depends(builder)])
def choose_dataset(slug: str, body: DatasetChoice, session: SessionDep, settings: SettingsDep) -> MinibrainDetail:
    minibrain = get_minibrain(session, slug)
    minibrain.dataset = get_dataset(session, body.dataset) if body.dataset else None
    minibrain.updated_at = now()
    session.commit()
    return detail(settings, minibrain)


@router.put("/{slug}/mapping", dependencies=[Depends(builder)])
def update_mapping(
    slug: str, body: MappingUpdate, session: SessionDep, settings: SettingsDep, store: StoreDep
) -> MinibrainDetail:
    minibrain = get_minibrain(session, slug)
    dataset = dataset_of(minibrain)
    apply_mapping(session, settings, store, dataset, body)
    take_version(session, settings, dataset)
    cleanup(session, settings)
    session.commit()
    return detail(settings, minibrain)


@router.post("/{slug}/query", dependencies=[Depends(builder)])
def query(slug: str, body: QueryRequest, session: SessionDep, settings: SettingsDep, store: StoreDep) -> QueryResponse:
    dataset = dataset_of(get_minibrain(session, slug))
    sources = sources_in(session, body.sql, dataset.sources)
    return query_rows(tables_of(settings, store, sources), body.sql, aliases_for(dataset.sources))


@router.get("/{slug}/preview", dependencies=[Depends(builder)])
def preview(slug: str, session: SessionDep, settings: SettingsDep, store: StoreDep) -> PreviewResponse:
    return dataset_preview_of(settings, store, dataset_of(get_minibrain(session, slug)))


@router.post("/{slug}/snapshots", status_code=201, dependencies=[Depends(builder)])
def build_snapshot(slug: str, session: SessionDep, settings: SettingsDep) -> MinibrainDetail:
    minibrain = get_minibrain(session, slug)
    take_version(session, settings, dataset_of(minibrain))
    cleanup(session, settings)
    session.commit()
    return detail(settings, minibrain)


@router.get("/{slug}/golden", dependencies=[Depends(builder)])
def golden(slug: str, session: SessionDep, store: StoreDep) -> list[ExampleInfo]:
    current = latest_snapshot(get_minibrain(session, slug))
    if current is None or not current.counts:
        return []
    examples = snapshot.read_split(snapshot_location(session, store, current), "golden")
    return [ExampleInfo(input=example.input, expected=example.expected) for example in examples]


def contract_check(minibrain: Minibrain, contract: Contract) -> ContractCheck:
    newest = latest_version_of(minibrain)
    if newest is None:
        return ContractCheck(changes=[], breaking=False, against=None)
    found = [ContractChange(**change.as_dict()) for change in changes(version_contract(newest), contract)]
    return ContractCheck(changes=found, breaking=any(item.breaking for item in found), against=newest.contract_number)


@router.post("/{slug}/contract/check", dependencies=[Depends(builder)])
def check_contract(slug: str, body: ContractInfo, session: SessionDep) -> ContractCheck:
    return contract_check(get_minibrain(session, slug), contract_from(body))


@router.put("/{slug}/contract", dependencies=[Depends(builder)])
def update_contract(slug: str, body: ContractUpdate, session: SessionDep, settings: SettingsDep) -> MinibrainDetail:
    minibrain = get_minibrain(session, slug)
    contract = contract_from(body.contract)
    found = contract_check(minibrain, contract)
    if found.breaking and not body.breaking:
        raise ConflictError("This contract removes or renames what apps rely on; confirm it as a breaking change")
    if preset(minibrain.preset).labels_from_data and contract.labels is None:
        raise ConflictError(f"{minibrain.name} answers with one label from a set; send labels")
    checked_graders(minibrain.graders or preset(minibrain.preset).default_graders(contract), contract)
    before = contract_of(minibrain).as_dict()
    minibrain.contract = contract.as_dict()
    minibrain.breaking_confirmed = found.breaking
    minibrain.updated_at = now()
    facts = {
        "name": minibrain.name,
        "breaking": found.breaking,
        "changes": [item.model_dump() for item in found.changes],
    }
    session.add(
        AuditEvent(actor=current_actor(), action="model.contract", target=slug, detail=facts | {"from": before})
    )
    session.commit()
    return detail(settings, minibrain)


@router.put("/{slug}/graders", dependencies=[Depends(builder)])
def update_graders(slug: str, body: GradersUpdate, session: SessionDep, settings: SettingsDep) -> MinibrainDetail:
    minibrain = get_minibrain(session, slug)
    configs = checked_graders(pinned(session, body.graders), contract_of(minibrain))
    facts = {"name": minibrain.name, "from": [item.get("name") for item in minibrain.graders]}
    minibrain.graders = configs
    minibrain.updated_at = now()
    facts["to"] = [item["name"] for item in configs]
    session.add(AuditEvent(actor=current_actor(), action="model.graders", target=slug, detail=facts))
    session.commit()
    return detail(settings, minibrain)


@router.put("/{slug}/promotion", dependencies=[Depends(builder)])
def update_promotion(slug: str, body: PromotionInfo, session: SessionDep, settings: SettingsDep) -> MinibrainDetail:
    minibrain = get_minibrain(session, slug)
    facts = {"name": minibrain.name, "from": dict(minibrain.promotion)}
    minibrain.promotion = rule_from(body, Rule())
    minibrain.updated_at = now()
    session.add(
        AuditEvent(
            actor=current_actor(), action="model.promotion", target=slug, detail=facts | {"to": minibrain.promotion}
        )
    )
    session.commit()
    return detail(settings, minibrain)


@router.put("/{slug}/instructions", dependencies=[Depends(builder)])
def update_instructions(
    slug: str, body: InstructionsUpdate, session: SessionDep, settings: SettingsDep
) -> MinibrainDetail:
    minibrain = get_minibrain(session, slug)
    minibrain.instructions = body.instructions.strip() or None
    minibrain.updated_at = now()
    session.add(
        AuditEvent(actor=current_actor(), action="model.instructions", target=slug, detail={"name": minibrain.name})
    )
    session.commit()
    return detail(settings, minibrain)
