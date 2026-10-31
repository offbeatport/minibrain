from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


class MinibrainCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)


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


class MappingUpdate(BaseModel):
    input_column: str | None = None
    label_column: str | None = None
    sql: str | None = None


class SnapshotInfo(BaseModel):
    hash: str
    counts: dict[str, int]
    labels: list[str]
    created_at: datetime


class JobInfo(BaseModel):
    id: int
    minibrain: str | None
    minibrain_name: str | None
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
    current_accuracy: float | None
    versions: int
    active_jobs: int


class MinibrainDetail(MinibrainSummary):
    source: SourceInfo | None
    mapping: MappingInfo
    snapshot: SnapshotInfo | None
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


class PreviewResponse(BaseModel):
    rows: list[PreviewRow]
    quality: QualityInfo
    labels: list[str]
    example: list[ChatMessage]


class ExampleInfo(BaseModel):
    input: str
    label: str


class VersionCreate(BaseModel):
    kind: Literal["prompt", "lora"]
    max_rows: int | None = Field(default=None, ge=10)
    epochs: float | None = Field(default=None, gt=0, le=10)


class PromoteRequest(BaseModel):
    override: bool = False


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


class KeyCreate(BaseModel):
    name: str = Field(default="default", max_length=60)


class KeyInfo(BaseModel):
    id: int
    name: str
    prefix: str
    created_at: datetime
    last_used_at: datetime | None


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
    libraries: dict[str, str]
    jobs: dict[str, int]
    loaded: list[LoadedModel]


class BaseModelInfo(BaseModel):
    key: str
    repo: str
    revision: str
    license: str


class InstallSettings(BaseModel):
    home: str
    database: str
    web: str
    base_models: list[BaseModelInfo]
    default_base_model: str
    recipe: dict[str, Any]
    splits: dict[str, int]
