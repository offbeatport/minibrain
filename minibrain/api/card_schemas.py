from typing import Literal

from pydantic import BaseModel, Field

CARD_SCHEMA = "minibrain.model_card"
CARD_SCHEMA_VERSION = 1
CANONICAL_FORM = (
    "SHA-256 of the UTF-8 bytes of the card serialised as JSON with keys sorted, no whitespace and non-ASCII "
    "characters kept, as json.dumps(card, sort_keys=True, separators=(',', ':'), ensure_ascii=False) writes it"
)

LicenceUseGroup = Literal["commercial", "restricted", "non-commercial", "unknown"]
DeploymentKind = Literal["deployed", "replaced", "undeployed"]


class CardVersion(BaseModel):
    id: str
    slug: str
    name: str
    number: int
    kind: str
    status: str
    created_at: str
    created_by: str | None


class CardPurpose(BaseModel):
    description: str
    task: str
    labels: list[str]


class CardBaseModel(BaseModel):
    key: str
    name: str
    publisher: str | None
    repo: str | None
    revision: str | None
    content_hash: str | None
    content_hash_recorded: bool
    licence: str | None
    licence_name: str | None
    licence_use: LicenceUseGroup
    licence_accepted_by: str | None
    licence_accepted_at: str | None


class CardSplits(BaseModel):
    train: int
    held_out: int
    test: int
    few_shot: int


class CardLabelRows(BaseModel):
    label: str
    rows: int
    share: float
    train: int
    held_out: int
    test: int


class CardSource(BaseModel):
    table: str
    name: str | None
    kind: str | None
    fingerprint: str


class CardCheck(BaseModel):
    check: str
    status: str
    title: str
    detail: str
    count: int


class CardData(BaseModel):
    dataset_slug: str | None
    dataset_name: str | None
    dataset_version: int | None = None
    dataset_version_feedback_rows: int = 0
    dataset_version_hash: str
    dataset_version_rows: int
    dataset_version_taken_at: str
    query: str | None
    splits: CardSplits
    label_balance: list[CardLabelRows] | None
    sources: list[CardSource]
    checks: list[CardCheck]
    personal_data: CardCheck | None


class CardRun(BaseModel):
    job_id: int
    started_at: str | None
    finished_at: str | None
    duration_seconds: float | None
    device: str | None
    machine: str | None


class CardRecipe(BaseModel):
    strategy: str | None = None
    max_rows: int | None
    epochs: float | None
    micro_batch: int | None
    grad_accum: int | None
    seq_len: int | None = None
    rank: int | None
    alpha: int | None
    learning_rate: float | None


class CardOrigin(BaseModel):
    slug: str
    name: str
    number: int


class CardTraining(BaseModel):
    method: str
    recipe: CardRecipe | None
    examples: int | None
    few_shot_examples: int | None
    train_loss: float | None
    run: CardRun | None
    duplicated_from: CardOrigin | None = None


class CardScore(BaseModel):
    examples: int
    accuracy: float
    macro_f1: float
    invalid_rate: float


class CardLabelScore(BaseModel):
    label: str
    support: int
    predicted: int
    correct: int
    precision: float | None
    recall: float | None
    f1: float | None


class CardConfusion(BaseModel):
    expected: str
    predicted: str | None
    count: int


class CardCost(BaseModel):
    source: str
    pool: str | None
    device: str | None
    device_name: str | None
    batch_size: int | None
    requests: int
    device_seconds_per_1k: float
    prompt_tokens: float | None
    completion_tokens: float | None
    hourly_price: float | None
    currency: str | None
    per_1k: float | None


class CardComparison(BaseModel):
    number: int
    kind: str
    same_data: bool
    held_out_accuracy: float | None
    held_out_macro_f1: float | None
    test_accuracy: float | None
    latency_p50_ms: float | None
    accuracy_change: float | None
    latency_p95_ms: float | None = None
    cost: CardCost | None = None


class CardEvaluation(BaseModel):
    scored: bool
    held_out: CardScore | None
    test_set: CardScore | None
    latency_p50_ms: float | None
    latency_p95_ms: float | None
    per_label: list[CardLabelScore] | None
    confusion: list[CardConfusion] | None
    run: CardRun | None
    prompt_only: CardComparison | None
    previous: CardComparison | None
    cost: CardCost | None = None


class CardLimit(BaseModel):
    kind: str
    text: str
    labels: list[str] = Field(default_factory=list)


class CardLimits(BaseModel):
    derived: list[CardLimit]
    known_limits: str


class CardUse(BaseModel):
    intended_use: str
    owner: str


class CardEvent(BaseModel):
    audit_id: int
    at: str
    actor: str
    action: str
    kind: DeploymentKind
    summary: str


class ModelCard(BaseModel):
    schema_name: str = CARD_SCHEMA
    schema_version: int = CARD_SCHEMA_VERSION
    version: CardVersion
    purpose: CardPurpose
    base_model: CardBaseModel
    training_data: CardData
    training: CardTraining
    evaluation: CardEvaluation
    limits: CardLimits
    use: CardUse
    approvals: list[CardEvent]
    deployments: list[CardEvent]


class ModelCardExport(BaseModel):
    card: ModelCard
    sha256: str
    canonical_form: str = CANONICAL_FORM


class ModelCardEdit(BaseModel):
    intended_use: str | None = Field(default=None, max_length=2000)
    known_limits: str | None = Field(default=None, max_length=10000)
