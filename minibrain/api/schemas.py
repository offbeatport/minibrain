from datetime import date, datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, StringConstraints

from minibrain.ml.planner import MAX_RANK
from minibrain.models.rules import LicenceUse

PresetKey = Literal["general", "classify", "custom"]
JudgeSource = Literal["model", "install", "base"]
MetricName = Annotated[str, StringConstraints(pattern=r"^[A-Za-z_][\w.]*$", max_length=80)]


class ContractInfo(BaseModel):
    kind: Literal["text", "json"]
    json_schema: dict[str, Any] | None = None
    labels: list[str] | None = None


class GraderConfig(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    rubric: str | None = Field(default=None, max_length=4000)
    model: str | None = Field(default=None, max_length=200)
    fields: list[str] | None = None


class ThresholdInfo(BaseModel):
    metric: MetricName
    op: Literal[">=", "<=", ">", "<", "=="]
    value: float


class PromotionInfo(BaseModel):
    thresholds: list[ThresholdInfo] = Field(default_factory=list)
    beats_live: bool = True


class RuleCheckInfo(BaseModel):
    name: str
    passed: bool
    detail: str
    actual: float | None = None
    metric: str | None = None
    op: Literal[">=", "<=", ">", "<", "=="] | None = None
    target: float | None = None
    live: int | None = None


class DecisionInfo(BaseModel):
    passed: bool
    checks: list[RuleCheckInfo]


class ContractChange(BaseModel):
    path: str
    detail: str
    breaking: bool


class ContractCheck(BaseModel):
    changes: list[ContractChange]
    breaking: bool
    against: int | None


class ContractUpdate(BaseModel):
    contract: ContractInfo
    breaking: bool = False


class GradersUpdate(BaseModel):
    graders: list[GraderConfig]


class JudgeUpdate(BaseModel):
    model: str | None = Field(default=None, max_length=200)


class JudgeInfo(BaseModel):
    model: str
    name: str
    source: JudgeSource
    override: str | None
    used: bool
    rubric: str | None
    default_rubric: str | None


class JudgeSetting(BaseModel):
    model: str | None
    name: str | None


class GuardInfo(BaseModel):
    key: str
    name: str
    kind: str


class SafetySetting(BaseModel):
    model: str | None = Field(description="The install's safety model, or null for none.")
    name: str | None
    answers: bool = Field(description="Whether it checks answers as well as requests.")
    guards: list[GuardInfo] = Field(description="The safety models on this install.")


class SafetyUpdate(BaseModel):
    model: str | None = Field(default=None, max_length=200)
    answers: bool = False


SafetyMode = Literal["inherit", "none", "model"]


class ModelSafety(BaseModel):
    mode: SafetyMode = Field(description="inherit follows Settings, none turns it off, model picks one.")
    model: str | None = Field(description="The safety model this model picks, when mode is model.")
    answers: bool
    effective: str | None = Field(description="The safety model that checks this model's calls, if any.")
    effective_name: str | None
    effective_answers: bool
    source: Literal["install", "model"]


class ModelSafetyUpdate(BaseModel):
    mode: SafetyMode
    model: str | None = Field(default=None, max_length=200)
    answers: bool = False


class InstructionsUpdate(BaseModel):
    instructions: str = Field(max_length=8000)


class ModelCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=280)
    tags: list[str] = Field(default_factory=list)
    base_model: str | None = None
    preset: PresetKey = "general"
    labels: list[str] = Field(default_factory=list)
    contract: ContractInfo | None = None
    instructions: str | None = Field(default=None, max_length=8000)
    graders: list[GraderConfig] | None = None
    promotion: PromotionInfo | None = None
    dataset: str | None = None


class ColumnInfo(BaseModel):
    name: str
    type: str


class SourceInfo(BaseModel):
    file: str
    columns: list[ColumnInfo]
    rows: int


class MappingInfo(BaseModel):
    input_column: str | None
    label_column: str | None
    template: dict[str, str] | None = None
    sql: str | None


SourceKind = Literal["upload", "folder", "s3", "database", "iceberg", "delta"]
FileFormat = Literal[".csv", ".tsv", ".json", ".jsonl", ".parquet"]


class SampleInfo(BaseModel):
    file: str
    name: str
    format: str
    rows: int
    labels: int
    description: str
    credit: str


class SourceRef(BaseModel):
    id: int
    name: str
    table: str
    kind: SourceKind


class SourceSummary(BaseModel):
    id: int
    kind: SourceKind
    name: str
    filename: str
    table: str
    description: str
    tags: list[str]
    size: int
    rows: int | None
    columns: list[ColumnInfo]
    datasets: list[str]
    created_at: datetime
    path: str | None = None
    format: str | None = None
    files: int | None = None
    modified_at: datetime | None = None
    error: str | None = None
    connection_id: int | None = None
    connection: str | None = None
    query: str | None = None
    change_column: str | None = None
    fingerprint: str | None = None
    fingerprint_detail: str | None = None


class SourceAdded(SourceSummary):
    outcome: Literal["created", "replaced", "existing"]


class NameTakenInfo(BaseModel):
    detail: str
    name: str
    suggestion: str
    taken: int | str


class S3SourceCreate(BaseModel):
    connection_id: int
    path: str = Field(min_length=6, max_length=4096)
    format: FileFormat | None = None
    name: str | None = Field(default=None, max_length=120)


class DatabaseSourceCreate(BaseModel):
    connection_id: int
    table: str | None = Field(default=None, max_length=512)
    query: str | None = Field(default=None, max_length=100_000)
    change_column: str | None = Field(default=None, max_length=128)
    name: str | None = Field(default=None, max_length=120)


class IcebergSourceCreate(BaseModel):
    connection_id: int
    path: str = Field(min_length=6, max_length=4096)
    name: str | None = Field(default=None, max_length=120)


class DeltaSourceCreate(BaseModel):
    path: str = Field(min_length=1, max_length=4096)
    name: str | None = Field(default=None, max_length=120)


class FolderCreate(BaseModel):
    path: str = Field(min_length=1, max_length=4096)
    name: str | None = Field(default=None, max_length=120)
    format: Literal[".csv", ".tsv", ".json", ".jsonl", ".parquet"] | None = None


class FolderRoots(BaseModel):
    roots: list[str]
    locked: bool


class CheckInfo(BaseModel):
    check: str
    status: Literal["ok", "warning", "blocked", "off", "skipped"]
    title: str
    detail: str
    count: int
    examples: list[str]
    signature: str
    dismissed: bool


class DatasetVersionInfo(BaseModel):
    id: int
    hash: str
    dataset: str | None
    number: int | None = None
    base_number: int | None = None
    rows: int
    size: int
    counts: dict[str, int]
    labels: list[str]
    saved: bool
    versions: list[str]
    created_at: datetime
    taken_at: datetime | None
    checks: list[CheckInfo] = Field(default_factory=list)
    feedback_rows: int = 0


class DismissRequest(BaseModel):
    signature: str = Field(min_length=1, max_length=64)


class LabelShiftInfo(BaseModel):
    label: str
    before: int
    after: int


class RelabelInfo(BaseModel):
    input: str
    before: str
    after: str


class DiffRow(BaseModel):
    input: str
    label: str


class DatasetVersionDiff(BaseModel):
    before: DatasetVersionInfo
    after: DatasetVersionInfo
    added: int
    removed: int
    relabelled: int
    unchanged: int
    labels: list[LabelShiftInfo]
    added_rows: list[DiffRow]
    removed_rows: list[DiffRow]
    relabelled_rows: list[RelabelInfo]


class ChangeInfo(BaseModel):
    data: bool
    query: bool
    dataset: bool


class DatasetSummary(BaseModel):
    slug: str
    name: str
    description: str
    tags: list[str]
    mode: Literal["columns", "sql"]
    source_id: int | None
    sources: list[SourceRef]
    rows: int | None
    columns: list[ColumnInfo]
    error: str | None
    mapping: MappingInfo
    models: list[str]
    model_names: list[str] = []
    test_examples: dict[str, int] = Field(
        default_factory=dict, description="Test examples from the Playground per model slug, held out for scoring."
    )
    splits: dict[str, int] | None
    dataset_version: DatasetVersionInfo | None = None
    changed: ChangeInfo | None = None
    row_limit: int = 0
    folder_id: int | None = None
    updated_at: datetime


class DatasetCreate(BaseModel):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
    source_id: int | None = None
    input_column: str | None = None
    label_column: str | None = None
    template: dict[str, str] | None = None
    sql: str | None = None
    folder_id: int | None = None


FolderName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]


class DatasetFolderInfo(BaseModel):
    id: int
    name: str
    parent_id: int | None
    created_at: datetime


class DatasetFolderCreate(BaseModel):
    name: FolderName
    parent_id: int | None = None


class DatasetFolderRename(BaseModel):
    name: FolderName


class DatasetFolderParent(BaseModel):
    parent_id: int | None


class DatasetFolderChoice(BaseModel):
    folder_id: int | None


class CatalogueUpdate(BaseModel):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)] | None = None
    description: str | None = Field(default=None, max_length=1000)
    tags: list[str] | None = Field(default=None, max_length=20)


class ColumnStats(BaseModel):
    name: str
    type: str
    nulls: int
    distinct: int
    min: str | None
    max: str | None


class SourceStats(BaseModel):
    rows: int
    sampled: int
    columns: list[ColumnStats]


class DatasetChoice(BaseModel):
    dataset: str | None


class MappingUpdate(BaseModel):
    source_id: int | None = None
    input_column: str | None = None
    label_column: str | None = None
    template: dict[str, str] | None = None
    sql: str | None = None


CheckName = Literal["duplicates", "conflicts", "balance", "leakage", "length", "personal_data"]


class DataSettings(BaseModel):
    row_limit: int = Field(ge=100, le=50_000_000)
    keep_versions: int = Field(ge=0, le=1000)
    checks_off: list[CheckName] = Field(default_factory=list)
    majority_share: float = Field(default=0.9, ge=0.5, le=1.0)
    min_label_rows: int = Field(default=10, ge=1, le=100_000)
    locked: dict[str, str] = Field(default_factory=dict)


class DataSettingsUpdate(BaseModel):
    row_limit: int | None = Field(default=None, ge=100, le=50_000_000)
    keep_versions: int | None = Field(default=None, ge=0, le=1000)
    checks_off: list[CheckName] | None = None
    majority_share: float | None = Field(default=None, ge=0.5, le=1.0)
    min_label_rows: int | None = Field(default=None, ge=1, le=100_000)


class DatasetVersionUsage(BaseModel):
    count: int
    size: int
    for_versions: int
    saved: int
    keep: int


class JobInfo(BaseModel):
    id: int
    model: str | None
    model_name: str | None
    base_model: str | None = None
    version: int | None
    deleted: bool = False
    version_deleted: bool = False
    kind: str
    status: str
    progress: float
    error: str | None
    attempt: int
    max_attempts: int
    cancel_requested: bool
    retry_of: int | None
    created_at: datetime
    run_after: datetime
    started_at: datetime | None
    finished_at: datetime | None
    base_model_name: str | None = Field(default=None, description="The base model's display name, for base jobs.")
    publisher: str | None = Field(default=None, description="The base model's publisher, for base jobs.")
    variant: str | None = Field(default=None, description="The precision of the base variant a download fetches.")
    score: float | None = Field(default=None, description="Held-out score of the version the job made or scored.")
    method: str | None = Field(default=None, description="Training method: sft for supervised fine-tuning.")
    strategy: str | None = Field(default=None, description="lora or qlora once the run is planned.")
    rank: int | None = None


class JobPage(BaseModel):
    items: list[JobInfo]
    next_cursor: str | None
    total: int


class JobFacets(BaseModel):
    total: int
    statuses: dict[str, int]
    models: dict[str, int]
    kinds: dict[str, int] = {}
    deleted_models: dict[str, str] = {}


class JobIds(BaseModel):
    ids: list[int] = Field(min_length=1, max_length=1000)


class JobActionResult(BaseModel):
    id: int
    done: bool
    status: str | None
    error: str | None = None
    retry: JobInfo | None = None


class AttemptInfo(BaseModel):
    number: int
    worker: str
    outcome: str
    error: str | None
    retryable: bool | None
    log: str | None
    started_at: datetime
    finished_at: datetime | None


class TrainingSetup(BaseModel):
    method: str
    planned: bool = Field(description="Whether the settings are the worker's fitted plan or still the request.")
    strategy: str | None
    precision: str | None
    rank: int | None
    epochs: float | None
    learning_rate: float | None
    batch: int | None
    seq_len: int | None
    max_rows: int | None
    examples: int | None
    held_out: int | None
    changed: list[str]


class JobSetup(BaseModel):
    dataset: str | None = None
    dataset_version: int | None = None
    dataset_rows: int | None = None
    version_kind: str | None = None
    base_model: str | None = None
    base_model_name: str | None = None
    variant: str | None = None
    revision: str | None = None
    size_bytes: int | None = None
    training: TrainingSetup | None = None


class JobDetail(JobInfo):
    attempts: list[AttemptInfo]
    result: dict[str, Any] | None
    outputs: dict[str, str]
    device: str | None = None
    host: str | None = None
    live: bool = False
    setup: JobSetup | None = None


class JobEventInfo(BaseModel):
    id: int
    attempt: int
    kind: str
    source: Literal["minibrain", "library", "system"]
    level: Literal["debug", "info", "warning", "error"]
    name: str | None
    message: str
    data: dict[str, Any] | None
    at: datetime


class TrainPoint(BaseModel):
    step: int
    epoch: float | None = None
    loss: float | None = None
    learning_rate: float | None = None
    grad_norm: float | None = None
    tokens_per_second: float | None = None
    memory_bytes: int | None = None


class EvalPoint(BaseModel):
    step: int
    eval_loss: float


class TrainingCurve(BaseModel):
    points: list[TrainPoint]
    evals: list[EvalPoint]


class TrainingMetrics(TrainingCurve):
    step: int | None
    steps: int | None
    epoch: float | None
    eta_seconds: float | None
    tokens_per_second: float | None
    memory_bytes: int | None
    rising_from: int | None


class PreviousTraining(TrainingCurve):
    job_id: int
    version: int | None


class TransferMetrics(BaseModel):
    bytes: int
    total: int
    bytes_per_second: float | None
    file: str | None


class CountedMetrics(BaseModel):
    done: int
    total: int


class JobMetrics(BaseModel):
    training: TrainingMetrics | None = None
    previous: PreviousTraining | None = None
    transfer: TransferMetrics | None = None
    counted: CountedMetrics | None = None


class ScoreInfo(BaseModel):
    grader: str
    version: int
    metric: str
    value: float


class LabelScoreInfo(BaseModel):
    label: str
    support: int
    predicted: int
    correct: int
    precision: float | None
    recall: float | None
    f1: float | None


class ConfusionInfo(BaseModel):
    gold: str
    predicted: str | None
    count: int


class FieldScoreInfo(BaseModel):
    field: str
    accuracy: float


class SplitScore(BaseModel):
    examples: int
    invalid_rate: float
    scores: list[ScoreInfo]
    labels: list[LabelScoreInfo] = Field(default_factory=list)
    confusion: list[ConfusionInfo] = Field(default_factory=list)
    fields: list[FieldScoreInfo] = Field(default_factory=list)
    judge_pending: int = 0


class EvalCost(BaseModel):
    source: Literal["device_time"]
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


class Mistake(BaseModel):
    input: str
    gold: str
    output: str


class PackedFileInfo(BaseModel):
    path: str
    size: int
    sha256: str


class VersionFiles(BaseModel):
    number: int
    artifact_id: str | None = Field(description="SHA-256 of the packed adapter; none for a prompt-only version.")
    size: int | None
    files: list[PackedFileInfo]


class VersionOrigin(BaseModel):
    slug: str
    name: str
    number: int
    job: int | None = None


class VersionInfo(BaseModel):
    number: int
    kind: str
    status: str
    current: bool
    dataset_version_hash: str | None
    dataset_version_id: int | None
    dataset_slug: str | None = None
    dataset_version_number: int | None = None
    dataset_version_rows: int = 0
    recipe: dict[str, Any]
    golden: SplitScore | None
    held_out: SplitScore | None
    latency_p50_ms: float | None
    latency_p95_ms: float | None
    prompt_tokens: float | None
    cost: EvalCost | None = None
    mistakes: list[Mistake]
    job: JobInfo | None
    created_at: datetime
    contract: ContractInfo
    contract_number: int
    instructions: str
    shots: int = 0
    graders: list[GraderConfig]
    main_metric: str | None
    score: float | None
    promotion: DecisionInfo | None = None
    live_at: datetime | None = None
    view: str | None = None
    duplicated_from: VersionOrigin | None = None
    base_model: str = Field(default="", description="The base the version was made on and runs on.")
    base_refusal: str | None = Field(
        default=None, description="Why the version can't be deployed: it was made on a base the model has left."
    )


TeardownKindName = Literal["delete", "undeploy"]
TeardownState = Literal["running", "failed"]


class TeardownInfo(BaseModel):
    kind: TeardownKindName
    state: TeardownState
    label: str
    detail: str
    error: str | None = None
    started_by: str
    started_at: datetime
    waiting: list[str] = Field(default_factory=list)
    models: list[str] = Field(default_factory=list)
    added: list[str] = Field(default_factory=list)
    jobs: list[int] = Field(default_factory=list)
    part_of: str | None = None
    cascade: bool = False
    undeploy: bool = False


class ModelSummary(BaseModel):
    slug: str
    name: str
    preset: str
    base_model: str
    current_version: int | None
    deployed: bool = False
    main_metric: str | None = None
    current_score: float | None
    versions: int
    active_jobs: int


class RequestBodiesInfo(BaseModel):
    kept: bool
    locked: bool
    source: str


class RequestBodiesUpdate(BaseModel):
    kept: bool


class LabelProposal(BaseModel):
    dataset_version_id: int
    dataset_version_number: int | None
    labels: list[str]


class LabelDismissal(BaseModel):
    dataset_version_id: int


class BaseTargetInfo(BaseModel):
    key: str = Field(description="The base's key, or the key it gets once downloaded.")
    name: str
    catalog_id: str
    variant_id: str
    size_bytes: int
    installed: bool = Field(description="On this install, or downloading or importing.")


class ServeOnlyInfo(BaseModel):
    format: str = Field(description="The quantized format, such as GGUF, AWQ or FP8.")
    reason: str = Field(description="Why Train is off and what to switch to.")
    switch_to: BaseTargetInfo | None = Field(description="The catalogue's full-precision variant of the base.")


class ModelDetail(ModelSummary):
    source: SourceInfo | None
    mapping: MappingInfo
    dataset: str | None = None
    dataset_name: str | None = None
    dataset_version: DatasetVersionInfo | None
    changed: ChangeInfo | None = None
    serve_only: ServeOnlyInfo | None = None
    models: list[str]
    request_bodies: RequestBodiesInfo
    teardown: TeardownInfo | None = None
    contract: ContractInfo
    contract_number: int
    instructions: str
    default_instructions: str
    graders: list[GraderConfig]
    graders_default: bool
    judge: JudgeInfo
    safety: ModelSafety
    promotion: PromotionInfo
    went_live: bool = False
    label_proposal: LabelProposal | None = None


class SampleDetail(ModelDetail):
    base_name: str
    download_bytes: int | None


class QueryRequest(BaseModel):
    sql: str = Field(min_length=1)


class QueryResponse(BaseModel):
    columns: list[str]
    rows: list[list[str | None]]


class QualityInfo(BaseModel):
    rows: int
    empty: int
    duplicates: int
    labels: int
    smallest_label: int
    largest_label: int
    mean_input_chars: float


class ChatMessage(BaseModel):
    role: str
    content: str


class PreviewRow(BaseModel):
    input: str | None
    label: str | None


class LabelCount(BaseModel):
    label: str
    rows: int


class PreviewResponse(BaseModel):
    rows: list[PreviewRow]
    quality: QualityInfo
    labels: list[str]
    label_counts: list[LabelCount]
    example: list[ChatMessage]


class ExampleInfo(BaseModel):
    input: str
    expected: str


class TrainingSettings(BaseModel):
    strategy: Literal["lora", "qlora"] | None = None
    checkpointing: bool | None = None
    micro_batch: int | None = Field(default=None, ge=1, le=64)
    seq_len: int | None = Field(default=None, ge=32, le=1_048_576)
    rank: int | None = Field(default=None, ge=1, le=MAX_RANK)
    learning_rate: float | None = Field(default=None, gt=0, le=0.01)
    epochs: float | None = Field(default=None, gt=0, le=10)
    max_rows: int | None = Field(default=None, ge=10)


class VersionCreate(TrainingSettings):
    kind: Literal["prompt", "lora"]
    dataset_version_id: int | None = None
    breaking: bool = False


class TrainingPlanQuery(TrainingSettings):
    dataset_version_id: int | None = None


class TrainingOptionInfo(BaseModel):
    strategy: str
    label: str
    checkpointing: bool
    micro_batch: int
    grad_accum: int
    device: str
    precision: str
    optimizer: str
    peak_bytes: int
    available_bytes: int | None
    fits: bool
    supported: bool
    reason: str | None
    parts: dict[str, int]


class TrainingDefaults(BaseModel):
    strategy: str | None
    checkpointing: bool | None
    micro_batch: int | None
    seq_len: int
    rank: int
    learning_rate: float
    epochs: float
    max_rows: int


class TrainingPlanInfo(BaseModel):
    level: Literal["fits", "insufficient", "unknown"]
    basis: str
    note: str | None
    machine: str | None
    memory_label: str | None
    chosen: TrainingOptionInfo | None
    options: list[TrainingOptionInfo]
    rows: int
    seq_len: int
    longest_tokens: int
    context: int | None
    overrides: list[str]
    defaults: TrainingDefaults


class VersionTest(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1)
    expected: str | None = None
    max_tokens: int | None = Field(default=None, ge=1, le=4096)


class VersionTestResult(BaseModel):
    output: str
    answer: str | None
    valid: bool
    scores: list[ScoreInfo]
    latency_ms: float
    prompt_tokens: int
    completion_tokens: int


class NameSuggestion(BaseModel):
    name: str


class GraderKindInfo(BaseModel):
    name: str
    label: str
    description: str
    contracts: list[str]
    metrics: list[str]


class PresetInfo(BaseModel):
    key: PresetKey
    label: str
    noun: str
    hint: str
    contract: Literal["labels", "choose", "text"]
    mapping: dict[str, str]
    prompts: dict[str, str]
    graders: dict[str, list[GraderConfig]]
    rubric: str | None
    expected: Literal["data"]
    checks: list[str]
    promotion: PromotionInfo
    view: str | None
    answer_tokens: int


class PlannedPresetInfo(BaseModel):
    key: str
    label: str
    hint: str


class PresetsResponse(BaseModel):
    presets: list[PresetInfo]
    planned: list[PlannedPresetInfo]
    graders: list[GraderKindInfo]


class TurnInfo(BaseModel):
    role: str
    content: str


class AnswerSide(BaseModel):
    answer: str
    scores: dict[str, float]
    reason: str | None


class ExampleAnswer(BaseModel):
    messages: list[TurnInfo]
    expected: str
    version: AnswerSide
    live: AnswerSide | None
    worse: bool | None


class VersionAnswers(BaseModel):
    number: int
    live: int | None
    metric: str | None
    examples: list[ExampleAnswer]


class ModelRef(BaseModel):
    kind: Literal["custom", "base"]
    key: str


class KeyModel(ModelRef):
    name: str


class KeyCreate(BaseModel):
    name: str = Field(default="default", max_length=60)
    models: list[ModelRef] = Field(min_length=1)


class KeyScopeUpdate(BaseModel):
    models: list[ModelRef] = Field(min_length=1)


class KeyInfo(BaseModel):
    id: int
    name: str
    prefix: str
    created_at: datetime
    last_used_at: datetime | None
    expires_at: datetime | None
    models: list[KeyModel]


class KeyCreated(KeyInfo):
    secret: str


class DeviceInfo(BaseModel):
    inference: str
    training: str
    accelerator: str | None
    memory_total_mb: float | None
    memory_used_mb: float | None
    cpu_count: int


class LoadedModel(BaseModel):
    base_model: str
    device: str
    adapters: list[str]


class SystemInfo(BaseModel):
    device: DeviceInfo
    jobs: dict[str, int]
    loaded: list[LoadedModel]
    loops: Literal["single", "leader", "standby"]


class InstallSettings(BaseModel):
    recipe: dict[str, Any]
    splits: dict[str, int]


class StorageSettings(BaseModel):
    kind: Literal["local", "s3"]
    endpoint: str
    bucket: str
    prefix: str
    region: str
    access_key: str
    secret_set: bool
    secret_from_environment: bool
    secret_reference: str | None = None
    locked: str | None = None
    location: str


class StorageUpdate(BaseModel):
    kind: Literal["local", "s3"]
    endpoint: str = Field(default="", max_length=2048)
    bucket: str = Field(default="", max_length=255)
    prefix: str = Field(default="minibrain", max_length=1024)
    region: str = Field(default="", max_length=64)
    access_key: str = Field(default="", max_length=256)
    secret: str | None = Field(default=None, max_length=1024)


class StorageCheck(BaseModel):
    ok: bool
    message: str


class StoreInfo(BaseModel):
    name: str
    kind: Literal["sqlite", "postgres", "folder", "s3"]
    location: str
    used_bytes: int | None
    free_bytes: int | None
    total_bytes: int | None


class InfrastructureInfo(BaseModel):
    setup: Literal["one_machine", "remote_gpus", "distributed"]
    host: str
    home: str
    web: str
    stores: list[StoreInfo]
    dataset_versions: DatasetVersionUsage | None = None


AvailabilityState = Literal["available", "downloading", "importing", "missing", "not_downloaded", "none"]
ActivityState = Literal["running", "queued", "failed", "ready", "needs_examples", "idle"]
DeploymentState = Literal["running", "starting", "unhealthy", "stopping", "stop_failed", "not_deployed"]


class Availability(BaseModel):
    state: AvailabilityState
    progress: float | None = None
    job_id: int | None = None


class Activity(BaseModel):
    state: ActivityState
    label: str
    kind: str | None = None
    version: int | None = None
    progress: float | None = None
    job_id: int | None = None


class Deployment(BaseModel):
    state: DeploymentState
    label: str
    versions: list[int] = Field(default_factory=list)


class Usage(BaseModel):
    days: list[str]
    daily: list[int]
    total: int
    previous: int
    failed: int
    last_at: datetime
    p50_ms: float | None


HealthState = Literal[
    "corrupt",
    "missing",
    "download_failed",
    "no_space",
    "needs_access",
    "source_gone",
    "cant_run",
    "no_memory",
    "base_changed",
    "base_unusable",
]
HealthActionKind = Literal[
    "repair",
    "reimport",
    "relocate",
    "remove",
    "resume",
    "storage",
    "get_access",
    "pick_variant",
    "find_smaller",
    "try_again",
    "verify",
    "open_base",
    "retrain",
]


class HealthAction(BaseModel):
    kind: HealthActionKind
    label: str


class Health(BaseModel):
    state: HealthState
    label: str
    detail: str
    actions: list[HealthAction]
    files: list[str] = Field(default_factory=list)


class VersionRow(BaseModel):
    number: int
    kind: str
    status: str
    live: bool
    score: float | None
    metric: str | None = None
    promotion: DecisionInfo | None = None
    was_live: bool = False
    progress: float | None
    job_id: int | None
    error: str | None
    usage: Usage | None
    created_at: datetime
    health: Health | None = None
    latency_p50_ms: float | None = None
    latency_p95_ms: float | None = None
    cost: EvalCost | None = None
    base_model: str = ""
    base_refusal: str | None = None


class ModelRow(BaseModel):
    kind: Literal["base", "custom"]
    key: str
    name: str
    description: str
    tags: list[str]
    base_model: str | None
    availability: Availability
    activity: Activity
    deployment: Deployment
    updated_at: datetime
    can_test: bool
    update_available: bool
    current_version: int | None
    ready_version: int | None
    needed_bytes: int | None
    publisher: str | None = None
    size_bytes: int | None = None
    score: float | None = None
    metric: str | None = None
    usage: Usage | None = None
    revision: str | None = None
    error: str | None = None
    versions: list[VersionRow] = []
    key_count: int = 0
    health: Health | None = None
    catalog_id: str | None = None
    last_used_at: datetime | None = None
    teardown: TeardownInfo | None = None
    serve_only: ServeOnlyInfo | None = None


class BaseChoice(BaseModel):
    key: str
    name: str
    state: Literal["ready", "pending"]
    current: bool
    serve_only: str | None = Field(description="The quantized format when the base can't be fine-tuned.")
    warnings: list[str] = Field(description="What the model loses on this base, such as tool calls or reasoning.")
    refusal: str | None = Field(description="Why the model can't switch to this base.")


class BaseOptions(BaseModel):
    current: str
    choices: list[BaseChoice]
    switch_to: BaseTargetInfo | None = Field(description="The catalogue's full-precision variant of the current base.")


class BaseSwitch(BaseModel):
    base_model: str = Field(min_length=1)


FileState = Literal["ok", "corrupt", "missing", "wrong_size", "unchecked"]


class ModelFile(BaseModel):
    path: str
    size: int
    sha256: str | None
    state: FileState = "unchecked"


class BaseModelDetail(ModelRow):
    source: str
    repo: str | None
    latest_revision: str | None
    source_path: str | None
    storage_path: str
    store: Literal["folder", "s3"] = "folder"
    store_label: str = "Main server disk"
    files: list[ModelFile]
    license: str | None
    license_name: str | None
    license_url: str | None
    license_ack_by: str | None
    license_ack_at: datetime | None
    variant_id: str | None
    deployed: bool
    verified: bool
    verified_at: datetime | None = None
    content_hash: str | None = None
    relocated: bool = False
    parameters: int | None = Field(default=None, description="Parameter count, from the catalogue or the weights.")
    context_tokens: int | None = None


class ModelDuplicate(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class ModelUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=280)
    tags: list[str] | None = None


class ImportRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    source_type: Literal["folder", "s3"] | None = None
    location: str = Field(min_length=1)
    connection_id: int | None = None
    variant_id: str | None = None
    description: str = ""
    tags: list[str] = Field(default_factory=list)


class LocationRequest(BaseModel):
    location: str = Field(min_length=1, max_length=4096)
    connection_id: int | None = None


class InspectRequest(BaseModel):
    location: str = Field(min_length=1)
    connection_id: int | None = None


class ImportCheckItem(BaseModel):
    label: str
    ok: bool
    detail: str | None = None


class ImportCheck(BaseModel):
    ok: bool
    problem: str | None = None
    checks: list[ImportCheckItem] = []
    source_type: Literal["folder", "s3"] | None = None
    resolved: str | None = None
    architecture: str | None = None
    files: int = 0
    size_bytes: int = 0
    name: str | None = None
    variant_id: str | None = None
    match: str | None = None
    connection_id: int | None = None
    connection: str | None = None


class DeployRequest(BaseModel):
    deployed: bool


class TestRequest(BaseModel):
    text: str = Field(min_length=1)
    max_tokens: int = Field(default=128, ge=1, le=1024)


class TestResponse(BaseModel):
    model: str
    output: str
    latency_ms: float
    prompt_tokens: int
    completion_tokens: int


class FitInfo(BaseModel):
    level: Literal["fits", "limited", "insufficient", "unknown"]
    needed_bytes: int
    available_bytes: int | None
    basis: str


class TrainFitInfo(BaseModel):
    level: Literal["fits", "insufficient", "unknown", "unsupported"]
    qlora_bytes: int | None
    available_bytes: int | None
    label: str | None
    basis: str


class CatalogVariantInfo(BaseModel):
    id: str
    label: str
    format: str
    precision: str
    repo: str
    revision: str
    latest_revision: str | None
    size_bytes: int
    weights_bytes: int
    files: int
    runtimes: list[str]
    requires: dict[str, Any]
    fit: FitInfo
    train_fit: TrainFitInfo


class AddedInfo(BaseModel):
    key: str
    variant_id: str | None
    availability: Availability
    error: str | None


class CatalogEntry(BaseModel):
    id: str
    name: str
    description: str
    provider: str
    repo: str
    capabilities: list[str]
    license: str
    license_name: str
    license_summary: str
    license_url: str
    license_use: LicenceUse
    gated: bool
    recommended: bool
    recommendation: str | None
    popularity: int
    context_tokens: int | None
    released: date | None
    family: str
    generation: str
    architecture: str
    tier: str
    params_b: float
    moe: bool
    superseded_by: str | None
    origin: str
    variants: list[CatalogVariantInfo]
    added: list[AddedInfo]


class HardwareInfo(BaseModel):
    machine: str
    accelerator: str
    kind: str
    memory_bytes: int | None
    ram_bytes: int | None
    memory_label: str
    gpus: int
    known: bool


class PoolChoice(BaseModel):
    name: str
    label: str


class CatalogResponse(BaseModel):
    entries: list[CatalogEntry]
    hardware: HardwareInfo
    pools: list[PoolChoice]
    pool: str
    online: bool | None
    offline_forced: bool
    hub_add_allowed: bool
    downloads_allowed: bool
    store_free_bytes: int | None
    store_total_bytes: int | None = None
    store_kind: Literal["folder", "s3"] = "folder"
    store_label: str = "Main server disk"
    staging_free_bytes: int | None = None
    endpoint: str
    token_configured: bool
    synced_at: datetime | None
    sync_job: JobInfo | None
    catalog_url: str | None


class DownloadRequest(BaseModel):
    variant: str
    accept_license: bool = False


ConnectionKind = Literal["s3", "postgres", "mysql"]


class ConnectionBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    kind: ConnectionKind
    endpoint: str = Field(default="", max_length=2048)
    region: str = Field(default="", max_length=64)
    bucket: str = Field(default="", max_length=255)
    access_key: str = Field(default="", max_length=256)
    path_style: bool = True
    host: str = Field(default="", max_length=255)
    port: int | None = Field(default=None, ge=1, le=65535)
    database: str = Field(default="", max_length=255)
    user: str = Field(default="", max_length=255)
    ssl_mode: str = Field(default="", max_length=32)
    secret: str | None = Field(default=None, max_length=4096)


class ConnectionTestBody(ConnectionBody):
    id: int | None = None


class ConnectionSourceRef(BaseModel):
    id: int
    name: str


class ConnectionInfo(BaseModel):
    id: int
    name: str
    kind: ConnectionKind
    endpoint: str
    region: str
    bucket: str
    access_key: str
    path_style: bool
    host: str
    port: int | None
    database: str
    user: str
    ssl_mode: str
    summary: str
    secret_set: bool
    secret_source: str | None
    locked: bool
    problem: str | None
    sources: list[ConnectionSourceRef]
    created_at: datetime
    updated_at: datetime


class ConnectionCheck(BaseModel):
    ok: bool
    message: str


class ConnectionTables(BaseModel):
    tables: list[str]


class ExtensionInfo(BaseModel):
    name: str
    purpose: str
    installed: bool


class ExtensionsInfo(BaseModel):
    version: str
    platform: str
    directory: str
    repository: str | None
    command: str
    extensions: list[ExtensionInfo]
