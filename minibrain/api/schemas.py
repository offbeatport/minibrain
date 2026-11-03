from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from minibrain.models.rules import LicenceUse


class MinibrainCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=280)
    tags: list[str] = Field(default_factory=list)
    base_model: str | None = None
    task: Literal["classify", "extract", "rewrite", "sql", "distill", "answer"] = "classify"
    sample: bool = False


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
    sql: str | None


SourceKind = Literal["upload", "folder", "s3", "database"]


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


class FolderCreate(BaseModel):
    path: str = Field(min_length=1, max_length=4096)
    name: str | None = Field(default=None, max_length=120)
    format: Literal[".csv", ".tsv", ".json", ".jsonl", ".parquet"] | None = None


class FolderRoots(BaseModel):
    roots: list[str]
    locked: bool


class SnapshotInfo(BaseModel):
    id: int
    hash: str
    dataset: str | None
    rows: int
    size: int
    counts: dict[str, int]
    labels: list[str]
    saved: bool
    versions: list[str]
    created_at: datetime
    taken_at: datetime | None


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


class SnapshotDiff(BaseModel):
    before: SnapshotInfo
    after: SnapshotInfo
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
    splits: dict[str, int] | None
    snapshot: SnapshotInfo | None = None
    changed: ChangeInfo | None = None
    row_limit: int = 0
    updated_at: datetime


class DatasetCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    source_id: int | None = None
    input_column: str | None = None
    label_column: str | None = None
    sql: str | None = None


class CatalogueUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
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
    sql: str | None = None


class DataSettings(BaseModel):
    row_limit: int = Field(ge=100, le=50_000_000)
    keep_snapshots: int = Field(ge=0, le=1000)


class DataSettingsUpdate(BaseModel):
    row_limit: int | None = Field(default=None, ge=100, le=50_000_000)
    keep_snapshots: int | None = Field(default=None, ge=0, le=1000)


class SnapshotUsage(BaseModel):
    count: int
    size: int
    for_versions: int
    saved: int
    keep: int


class JobInfo(BaseModel):
    id: int
    minibrain: str | None
    minibrain_name: str | None
    model: str | None = None
    version: int | None
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


class AttemptInfo(BaseModel):
    number: int
    worker: str
    outcome: str
    error: str | None
    retryable: bool | None
    log: str | None
    started_at: datetime
    finished_at: datetime | None


class JobDetail(JobInfo):
    attempts: list[AttemptInfo]
    result: dict[str, Any] | None
    outputs: dict[str, str]


class JobEventInfo(BaseModel):
    id: int
    attempt: int
    kind: str
    message: str
    data: dict[str, Any] | None
    at: datetime


class SplitScore(BaseModel):
    examples: int
    accuracy: float
    macro_f1: float
    invalid_rate: float


class Mistake(BaseModel):
    input: str
    gold: str
    output: str


class VersionInfo(BaseModel):
    number: int
    kind: str
    status: str
    current: bool
    snapshot_hash: str
    snapshot_id: int
    snapshot_dataset: str | None = None
    snapshot_rows: int = 0
    recipe: dict[str, Any]
    golden: SplitScore | None
    held_out: SplitScore | None
    latency_p50_ms: float | None
    latency_p95_ms: float | None
    prompt_tokens: float | None
    mistakes: list[Mistake]
    job: JobInfo | None
    created_at: datetime


class MinibrainSummary(BaseModel):
    slug: str
    name: str
    task: str
    base_model: str
    current_version: int | None
    deployed: bool = False
    current_accuracy: float | None
    versions: int
    active_jobs: int


class MinibrainDetail(MinibrainSummary):
    source: SourceInfo | None
    mapping: MappingInfo
    dataset: str | None = None
    dataset_name: str | None = None
    snapshot: SnapshotInfo | None
    changed: ChangeInfo | None = None
    models: list[str]


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
    label: str


class VersionCreate(BaseModel):
    kind: Literal["prompt", "lora"]
    max_rows: int | None = Field(default=None, ge=10)
    epochs: float | None = Field(default=None, gt=0, le=10)


class CompleteRequest(BaseModel):
    text: str = Field(min_length=1)
    version: int | None = None
    max_tokens: int = Field(default=24, ge=1, le=512)


class CompleteResponse(BaseModel):
    model: str
    output: str
    label: str | None
    latency_ms: float
    prompt_tokens: int
    completion_tokens: int


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
    snapshots: SnapshotUsage | None = None


AvailabilityState = Literal["available", "downloading", "importing", "missing", "not_downloaded", "none"]
ActivityState = Literal["running", "queued", "failed", "ready", "needs_examples", "idle"]
DeploymentState = Literal["running", "starting", "unhealthy", "not_deployed"]


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


class Stage(BaseModel):
    key: Literal["data", "train", "evaluate", "deploy"]
    state: Literal["todo", "active", "done", "failed"]
    label: str
    progress: float | None = None


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
    accuracy: float | None
    progress: float | None
    job_id: int | None
    error: str | None
    usage: Usage | None
    created_at: datetime
    health: Health | None = None


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
    stages: list[Stage] = []
    accuracy: float | None = None
    usage: Usage | None = None
    revision: str | None = None
    error: str | None = None
    versions: list[VersionRow] = []
    key_count: int = 0
    health: Health | None = None
    catalog_id: str | None = None


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


class ModelUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=280)
    tags: list[str] | None = None


class ImportRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    source_type: Literal["folder", "s3"] | None = None
    location: str = Field(min_length=1)
    variant_id: str | None = None
    description: str = ""
    tags: list[str] = Field(default_factory=list)


class LocationRequest(BaseModel):
    location: str = Field(min_length=1, max_length=4096)


class InspectRequest(BaseModel):
    location: str = Field(min_length=1)


class ImportCheck(BaseModel):
    ok: bool
    problem: str | None = None
    source_type: Literal["folder", "s3"] | None = None
    resolved: str | None = None
    architecture: str | None = None
    files: int = 0
    size_bytes: int = 0
    name: str | None = None
    variant_id: str | None = None
    match: str | None = None


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
    endpoint: str
    token_configured: bool
    synced_at: datetime | None
    sync_job: JobInfo | None
    catalog_url: str | None


class DownloadRequest(BaseModel):
    variant: str
    accept_license: bool = False
