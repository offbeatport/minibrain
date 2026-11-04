from dataclasses import dataclass

from sqlalchemy.orm import Session

from minibrain.api.schemas import Health, HealthAction, HealthActionKind
from minibrain.models import hub
from minibrain.models.hardware import NodeReport
from minibrain.models.health import (
    CANT_RUN,
    CORRUPT,
    NEEDS_ACCESS,
    NO_MEMORY,
    NO_SPACE,
    OFFLINE,
    SOURCE_GONE,
    base_changed,
    file_states,
    missing_message,
    size_problems,
)
from minibrain.models.registry import TRANSFER_KINDS, gguf_file, model_folder
from minibrain.models.sources import FOLDER, HUB, S3
from minibrain.policy import load as load_policy
from minibrain.registry.compute import pools
from minibrain.registry.models import (
    ACTIVE_JOB_STATUSES,
    SYSTEM_ACTOR,
    CatalogVariant,
    Job,
    JobKind,
    JobStatus,
    Minibrain,
    Model,
    ModelStatus,
    Version,
    VersionKind,
)
from minibrain.settings import Settings
from minibrain.storage import size_text

LABELS: dict[str, str] = {
    "repair": "Repair",
    "reimport": "Re-import",
    "relocate": "Point to new location",
    "remove": "Remove",
    "resume": "Resume",
    "storage": "Free up space",
    "get_access": "Get access",
    "pick_variant": "Pick another variant",
    "try_again": "Try again",
    "verify": "Verify files",
    "open_base": "Open base model",
    "retrain": "Train again",
    "download_again": "Download again",
}
STOPPED = (JobStatus.FAILED, JobStatus.CANCELLED)


@dataclass(frozen=True)
class HealthContext:
    settings: Settings
    hub_ok: bool
    engines: frozenset[str] | None = None


def health_context(session: Session, settings: Settings, node: NodeReport | None = None) -> HealthContext:
    policy = load_policy(session)
    hub_ok = not hub.offline() and policy.outbound_allowed(hub.endpoint()) and policy["model_sources"] != "imports"
    if node is None:
        return HealthContext(settings=settings, hub_ok=hub_ok)
    online = [item for pool in pools(session, node) for item in pool.nodes if item.online]
    engines = frozenset(engine for item in online for engine in item.report.engines)
    return HealthContext(settings=settings, hub_ok=hub_ok, engines=engines)


def act(kind: HealthActionKind, label: str | None = None) -> HealthAction:
    return HealthAction(kind=kind, label=label or LABELS[kind])


def repairable(model: Model, context: HealthContext) -> bool:
    return context.hub_ok and bool(model.repo and model.revision and model.files)


def complete_files(model: Model, context: HealthContext) -> int:
    problems = size_problems(model_folder(context.settings, model), model.files)
    return len(model.files) - len(problems)


def noun(job: Job | None, model: Model) -> str:
    if job is None:
        return "Download" if model.source == "download" else "Import"
    if job.kind == JobKind.REPAIR:
        restoring = "Download" if model.status == ModelStatus.EVICTED else "Repair"
        return restoring if job.params.get("source") == HUB else "Re-import"
    return "Download" if job.kind == JobKind.DOWNLOAD else "Import"


def stopped(model: Model, job: Job | None, context: HealthContext) -> Health:
    cancelled = job is not None and job.status == JobStatus.CANCELLED
    what = noun(job, model)
    error = (job.error if job else None) or model.error
    detail = "It was cancelled before it finished." if cancelled else f"{error or 'It stopped without a message'}."
    done = complete_files(model, context) if job is None or job.kind != JobKind.IMPORT else 0
    resumable = done > 0 and model.status != ModelStatus.AVAILABLE
    if resumable:
        detail += f" {done} of {len(model.files)} files are complete and kept; resuming fetches only the rest."
    else:
        detail += " Try again; files already complete are kept."
    actions = [act("resume", "Resume" if resumable or cancelled else "Retry")]
    if (model.status == ModelStatus.AVAILABLE and what == "Repair") or model.status == ModelStatus.EVICTED:
        actions.append(act("reimport"))
    if model.status != ModelStatus.AVAILABLE:
        actions.append(act("remove"))
    label = f"{what} {'cancelled' if cancelled else 'failed'}"
    return Health(state="download_failed", label=label, detail=detail, actions=actions)


def transfer_failure(model: Model, job: Job | None, context: HealthContext) -> Health | None:
    if job is None or job.kind not in TRANSFER_KINDS or job.status not in STOPPED:
        return None
    message = job.error or ""
    installed = model.status == ModelStatus.AVAILABLE
    if job.error_code == NEEDS_ACCESS:
        actions = [act("get_access"), act("resume", "Retry")]
        return Health(state="needs_access", label="Needs access", detail=message, actions=actions)
    if job.error_code in (SOURCE_GONE, OFFLINE):
        label = "Can't repair from source" if installed else "Can't download from source"
        others = [act("verify")] if installed else [act("remove")]
        return Health(state="source_gone", label=label, detail=message, actions=[act("reimport"), *others])
    if job.error_code == NO_SPACE:
        return Health(
            state="no_space",
            label="Not enough space",
            detail=f"{message} Infrastructure → Storage shows what uses the disk.",
            actions=[act("storage"), act("resume", "Try again")],
        )
    return stopped(model, job, context)


def corrupt(model: Model, context: HealthContext) -> Health:
    states = file_states(model)
    count = len(states)
    message = (model.health_detail or {}).get("message") or "Some files do not match the SHA-256 saved at install."
    if repairable(model, context):
        detail = f"{message} Repair downloads only those files again from {hub.endpoint()}."
        actions = [act("repair"), act("reimport"), act("verify")]
    else:
        detail = f"{message} Re-import them from a folder or S3 path that holds an intact copy."
        actions = [act("reimport"), act("verify")]
    label = f"Corrupt ({count} file{'' if count == 1 else 's'})"
    return Health(state="corrupt", label=label, detail=detail, actions=actions, files=sorted(states))


def missing(model: Model, problems: dict[str, str], context: HealthContext) -> Health:
    folder = model_folder(context.settings, model)
    if repairable(model, context):
        fix = "Repair downloads them again, or point to the folder they moved to."
        actions = [act("repair"), act("relocate"), act("remove")]
    else:
        fix = "Point to the folder they moved to, re-import them, or remove the model."
        actions = [act("relocate"), act("reimport"), act("remove")]
    detail = f"{missing_message(problems)} in {folder}. {fix}"
    return Health(state="missing", label="Missing files", detail=detail, actions=actions, files=sorted(problems))


def smaller_variants(model: Model) -> list[CatalogVariant]:
    variant = model.variant
    if variant is None:
        return []
    current = variant.weights_bytes or model.size_bytes
    found = [item for item in variant.model.variants if item.id != variant.id and 0 < item.weights_bytes < current]
    return sorted(found, key=lambda item: item.weights_bytes, reverse=True)


def other_variants(model: Model) -> list[CatalogVariant]:
    variant = model.variant
    return [item for item in variant.model.variants if item.id != variant.id] if variant is not None else []


def load_failure(model: Model, context: HealthContext) -> Health:
    detail = (model.health_detail or {}).get("message") or "The engine could not load it."
    if model.health == NO_MEMORY:
        smaller = smaller_variants(model)
        if smaller:
            names = ", ".join(f"{item.label} ({size_text(item.weights_bytes)})" for item in smaller[:3])
            detail += f" Pick a smaller or quantized variant: {names}."
        else:
            detail += " No smaller variant of it is in the catalogue; pick a smaller model on Discover."
        actions = [act("pick_variant", "Pick a smaller variant"), act("try_again")]
        return Health(state="no_memory", label="Failed to start", detail=detail, actions=actions)
    actions = [act("pick_variant"), act("try_again")] if other_variants(model) else [act("try_again")]
    return Health(state="cant_run", label="Can't run here", detail=detail, actions=actions)


def capability(model: Model, context: HealthContext) -> Health | None:
    if context.engines is None or gguf_file(model) is None or "llamacpp" in context.engines:
        return None
    alternative = any(item.format != "gguf" for item in other_variants(model))
    detail = (
        "GGUF weights need llama.cpp, and no machine in the compute pools has it. Install minibrain[llamacpp] on "
        "the machine that serves it"
    )
    detail += ", or pick the safetensors variant." if alternative else "."
    actions = [act("pick_variant", "Pick the safetensors variant")] if alternative else []
    return Health(state="cant_run", label="Can't run here", detail=detail, actions=actions)


def original_location(model: Model) -> str | None:
    kind, _, location = (model.source_path or "").partition(":")
    return location if kind in (FOLDER, S3) and location else None


def removed_by_person(model: Model) -> bool:
    return model.evicted_by is not None and model.evicted_by != SYSTEM_ACTOR


def evicted(model: Model, context: HealthContext) -> Health:
    when = f" on {model.evicted_at:%Y-%m-%d}" if model.evicted_at else ""
    if removed_by_person(model):
        detail = (
            f"{model.evicted_by} removed its files{when} to free the disk. Its record, licence acceptance, API keys "
            "and the models built on it stay."
        )
    else:
        detail = (
            f"Its files were removed{when} to free space while no model, version, deployment or job used it. Its "
            "record, licence acceptance and API keys stay."
        )
    location = original_location(model)
    copy = f", such as {location}" if location else ""
    if repairable(model, context):
        detail += (
            f" Download again fetches the same files from {hub.endpoint()} and checks each against the SHA-256 "
            f"saved at install; Re-import copies them from a folder or S3 path{copy}."
        )
        actions = [act("download_again"), act("reimport"), act("remove")]
    else:
        detail += f" Re-import it from a folder or S3 path that holds the same files{copy}."
        actions = [act("reimport"), act("remove")]
    label = "Files removed" if removed_by_person(model) else "Removed to free space"
    return Health(state="evicted", label=label, detail=detail, actions=actions)


def base_health(model: Model, job: Job | None, context: HealthContext) -> Health | None:
    if job is not None and job.status in ACTIVE_JOB_STATUSES:
        return None
    failed = transfer_failure(model, job, context)
    if failed is not None:
        return failed
    if model.status == ModelStatus.EVICTED:
        return evicted(model, context)
    if model.status in STOPPED:
        return stopped(model, None, context)
    if model.status != ModelStatus.AVAILABLE:
        return None
    if model.health == CORRUPT:
        return corrupt(model, context)
    if model.health in (CANT_RUN, NO_MEMORY):
        return load_failure(model, context)
    problems = size_problems(model_folder(context.settings, model), model.files)
    if problems:
        return missing(model, problems, context)
    return capability(model, context)


def custom_health(base: Health | None, base_name: str) -> Health | None:
    if base is None:
        return None
    shown = "Missing files" if base.state == "evicted" else base.label
    label = f"Base {shown[0].lower()}{shown[1:]}"
    return Health(
        state="base_unusable",
        label=label,
        detail=f"Its base model {base_name}: {base.detail}",
        actions=[act("open_base")],
        files=base.files,
    )


def version_health(minibrain: Minibrain, version: Version, current: str | None) -> Health | None:
    if version.kind != VersionKind.LORA:
        return None
    message = base_changed(f"v{version.number}", minibrain.base_model, version.base_hash, current)
    if message is None:
        return None
    return Health(state="base_changed", label="Base changed", detail=message, actions=[act("retrain")])
