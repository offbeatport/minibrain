from collections import Counter
from datetime import UTC, datetime
from typing import Any

import duckdb
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from minibrain.api.card_schemas import (
    CardBaseModel,
    CardCheck,
    CardComparison,
    CardConfusion,
    CardCost,
    CardData,
    CardEvaluation,
    CardEvent,
    CardLabelRows,
    CardLabelScore,
    CardLimit,
    CardLimits,
    CardPurpose,
    CardRecipe,
    CardRun,
    CardScore,
    CardSource,
    CardSplits,
    CardTraining,
    CardUse,
    CardVersion,
    DeploymentKind,
    ModelCard,
)
from minibrain.artifacts import ArtifactError
from minibrain.base_models import BASE_MODELS
from minibrain.data.dataset_versions import version_number
from minibrain.data.splits import SPLITS, DatasetVersionError, read_split
from minibrain.models.health import content_hash
from minibrain.models.rules import LICENCES, licence_use, publisher_of
from minibrain.registry.files import MissingArtifactError, dataset_version_location, store_for
from minibrain.registry.models import (
    AttemptOutcome,
    AuditEvent,
    BaseModel,
    BaseModelStatus,
    DatasetVersion,
    Job,
    JobKind,
    JobStatus,
    Model,
    Source,
    Version,
    VersionKind,
    VersionStatus,
    Worker,
)
from minibrain.registry.prices import DevicePrices, eval_cost, load_prices
from minibrain.registry.service import ConflictError
from minibrain.settings import Settings
from minibrain.tasks.examples import Example
from minibrain.tasks.graders import metric_values
from minibrain.tasks.service import version_metric

CARD_ACTIONS = ("version.create", "version.promote", "model.deploy", "model.undeploy")
FEW_TRAINING_ROWS = 10
LOW_RECALL = 0.5
SMALL_HELD_OUT = 200
DIGITS = 4
RECIPE_INTS = ("max_rows", "micro_batch", "grad_accum", "seq_len", "rank", "alpha")


def stamp(moment: datetime | None) -> str | None:
    return None if moment is None else moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def rounded(value: Any, digits: int = DIGITS) -> float | None:
    return None if value is None else round(float(value), digits)


def whole(value: Any) -> int | None:
    return None if value is None else int(value)


def card_events(session: Session, model: Model) -> list[AuditEvent]:
    targets = or_(AuditEvent.target == model.slug, AuditEvent.target.startswith(f"{model.slug}@", autoescape=True))
    query = (
        select(AuditEvent)
        .where(AuditEvent.action.in_(CARD_ACTIONS), targets, AuditEvent.at >= model.created_at)
        .order_by(AuditEvent.id)
    )
    return list(session.scalars(query))


def history_entry(event: AuditEvent, kind: DeploymentKind, summary: str) -> CardEvent:
    return CardEvent(
        audit_id=event.id,
        at=stamp(event.at) or "",
        actor=event.actor,
        action=event.action,
        kind=kind,
        summary=summary,
    )


def promoted_entry(event: AuditEvent, number: int) -> CardEvent:
    previous = event.detail.get("previous")
    replacing = previous is not None and previous != number and event.detail.get("was_deployed")
    summary = f"Deployed v{number}, replacing v{previous}" if replacing else f"Deployed v{number}"
    return history_entry(event, "deployed", summary)


def history_of(events: list[AuditEvent], model: Model, number: int) -> list[CardEvent]:
    target = f"{model.slug}@{number}"
    found: list[CardEvent] = []
    for event in events:
        detail = event.detail or {}
        if event.action == "version.promote" and event.target == target:
            found.append(promoted_entry(event, number))
        elif event.action == "version.promote" and detail.get("previous") == number and detail.get("was_deployed"):
            found.append(history_entry(event, "replaced", f"Replaced by v{event.target.rsplit('@', 1)[-1]}"))
        elif event.target == model.slug and detail.get("version") == number:
            if event.action == "model.deploy":
                found.append(history_entry(event, "deployed", f"Deployed v{number} again"))
            elif event.action == "model.undeploy":
                found.append(history_entry(event, "undeployed", f"Undeployed v{number}"))
    return found


def creator_of(events: list[AuditEvent], model: Model, number: int) -> str | None:
    target = f"{model.slug}@{number}"
    return next((e.actor for e in events if e.action == "version.create" and e.target == target), None)


def licence_key(licence: str | None) -> str | None:
    return licence.strip().lower() if licence else None


def base_card(session: Session, model: Model, version: Version) -> CardBaseModel:
    key = model.base_model
    base = session.get(BaseModel, key)
    builtin = BASE_MODELS.get(key)
    repo = base.repo if base is not None else builtin.repo if builtin is not None else None
    revision = base.revision if base is not None else builtin.revision if builtin is not None else None
    licence = base.license if base is not None else builtin.license if builtin is not None else None
    current = None
    if base is not None and base.status == BaseModelStatus.AVAILABLE:
        current = content_hash(base.files)
    elif builtin is not None:
        current = builtin.content_hash
    variant = base.variant if base is not None else None
    publisher = variant.model.provider if variant is not None else publisher_of(repo)
    found = licence_key(licence)
    return CardBaseModel(
        key=key,
        name=base.name if base is not None else key,
        publisher=publisher,
        repo=repo,
        revision=revision,
        content_hash=version.base_hash or current,
        content_hash_recorded=version.base_hash is not None,
        licence=licence,
        licence_name=LICENCES[found][0] if found in LICENCES else None,
        licence_use=licence_use(found) if found else "unknown",
        licence_accepted_by=base.license_ack_by if base is not None else None,
        licence_accepted_at=stamp(base.license_ack_at) if base is not None else None,
    )


def dataset_version_splits(
    session: Session, settings: Settings, dataset_version: DatasetVersion
) -> dict[str, list[Example]] | None:
    try:
        path = dataset_version_location(session, store_for(settings), dataset_version)
        return {name: read_split(path, name) for name in SPLITS}
    except (MissingArtifactError, ArtifactError, DatasetVersionError, OSError, duckdb.Error):
        return None


def label_balance(splits: dict[str, list[Example]]) -> list[CardLabelRows]:
    per_split = {name: Counter(example.expected for example in examples) for name, examples in splits.items()}
    total = Counter[str]()
    for counts in per_split.values():
        total.update(counts)
    rows = sum(total.values()) or 1
    ordered = sorted(total.items(), key=lambda item: (-item[1], item[0]))
    return [
        CardLabelRows(
            label=label,
            rows=count,
            share=round(count / rows, DIGITS),
            train=per_split["train"][label],
            held_out=per_split["eval"][label],
            test=per_split["golden"][label],
        )
        for label, count in ordered
    ]


def source_card(session: Session, table: str, fingerprint: str) -> CardSource:
    source = session.scalar(select(Source).where(Source.table_name == table))
    return CardSource(
        table=table,
        name=source.name if source is not None else None,
        kind=source.kind if source is not None else None,
        fingerprint=fingerprint,
    )


def check_card(item: dict[str, Any]) -> CardCheck:
    return CardCheck(
        check=str(item.get("check", "")),
        status=str(item.get("status", "")),
        title=str(item.get("title", "")),
        detail=str(item.get("detail", "")),
        count=int(item.get("count", 0) or 0),
    )


def data_card(session: Session, dataset_version: DatasetVersion, splits: dict[str, list[Example]] | None) -> CardData:
    counts = dataset_version.counts or {}
    checks = [check_card(item) for item in dataset_version.checks or []]
    dataset = dataset_version.dataset
    return CardData(
        dataset_slug=dataset.slug if dataset is not None else None,
        dataset_name=dataset.name if dataset is not None else None,
        dataset_version=version_number(dataset_version),
        dataset_version_feedback_rows=dataset_version.feedback_rows,
        dataset_version_hash=dataset_version.hash,
        dataset_version_rows=dataset_version.rows or sum(counts.values()),
        dataset_version_taken_at=stamp(dataset_version.taken_at or dataset_version.created_at) or "",
        query=dataset_version.sql,
        splits=CardSplits(
            train=int(counts.get("train", 0)),
            held_out=int(counts.get("eval", 0)),
            test=int(counts.get("golden", 0)),
            few_shot=int(counts.get("shots", 0)),
        ),
        label_balance=label_balance(splits) if splits is not None else None,
        sources=[
            source_card(session, table, value) for table, value in sorted((dataset_version.fingerprints or {}).items())
        ],
        checks=checks,
        personal_data=next((check for check in checks if check.check == "personal_data"), None),
    )


def version_job(model: Model, version: Version, kind: JobKind) -> Job | None:
    jobs = [job for job in model.jobs if job.version_id == version.id and job.kind == kind]
    done = [job for job in jobs if job.status == JobStatus.SUCCEEDED]
    return max(done or jobs, key=lambda job: job.id, default=None)


def machine_of(session: Session, job: Job) -> str | None:
    attempts = [attempt for attempt in job.attempts if attempt.outcome == AttemptOutcome.SUCCEEDED] or job.attempts
    if not attempts:
        return None
    worker = session.get(Worker, attempts[-1].worker)
    return worker.host if worker is not None else None


def run_card(session: Session, job: Job | None, device: Any) -> CardRun | None:
    if job is None:
        return None
    duration = None
    if job.started_at is not None and job.finished_at is not None:
        duration = round((job.finished_at - job.started_at).total_seconds(), 1)
    return CardRun(
        job_id=job.id,
        started_at=stamp(job.started_at),
        finished_at=stamp(job.finished_at),
        duration_seconds=duration,
        device=str(device) if device else None,
        machine=machine_of(session, job),
    )


def recipe_card(recipe: dict[str, Any]) -> CardRecipe:
    ints = {key: whole(recipe.get(key)) for key in RECIPE_INTS}
    plan = recipe.get("plan")
    label = plan.get("label") if isinstance(plan, dict) else None
    return CardRecipe(
        strategy=str(label) if label else None,
        max_rows=ints["max_rows"],
        epochs=rounded(recipe.get("epochs")),
        micro_batch=ints["micro_batch"],
        grad_accum=ints["grad_accum"],
        seq_len=ints["seq_len"],
        rank=ints["rank"],
        alpha=ints["alpha"],
        learning_rate=None if recipe.get("learning_rate") is None else float(recipe["learning_rate"]),
    )


def training_card(session: Session, model: Model, version: Version) -> CardTraining:
    if version.kind != VersionKind.LORA:
        shots = len(version.shots or [])
        return CardTraining(
            method="prompt", recipe=None, examples=None, few_shot_examples=shots, train_loss=None, run=None
        )
    job = version_job(model, version, JobKind.TRAIN)
    recipe = dict((job.params.get("recipe") if job is not None else None) or {}) | dict(version.recipe or {})
    return CardTraining(
        method="lora",
        recipe=recipe_card(recipe),
        examples=whole(recipe.get("examples")),
        few_shot_examples=None,
        train_loss=rounded(recipe.get("train_loss")),
        run=run_card(session, job, recipe.get("device")),
    )


def main_of(split: dict[str, Any] | None, metric: str | None) -> float | None:
    values = metric_values(split)
    return None if metric is None or metric not in values else values[metric]


def score_card(split: dict[str, Any] | None, metric: str | None) -> CardScore | None:
    if not split or "scores" not in split:
        return None
    values = metric_values(split)
    return CardScore(
        examples=int(split.get("examples", 0)),
        accuracy=rounded(main_of(split, metric)) or 0.0,
        macro_f1=rounded(values.get("macro_f1", 0.0)) or 0.0,
        invalid_rate=rounded(split.get("invalid_rate", 0.0)) or 0.0,
    )


def label_report(split: dict[str, Any] | None) -> dict[str, Any]:
    return ((split or {}).get("reports") or {}).get("label_accuracy") or {}


def label_score(item: dict[str, Any]) -> CardLabelScore:
    return CardLabelScore(
        label=str(item["label"]),
        support=int(item.get("support", 0)),
        predicted=int(item.get("predicted", 0)),
        correct=int(item.get("correct", 0)),
        precision=rounded(item.get("precision")),
        recall=rounded(item.get("recall")),
        f1=rounded(item.get("f1")),
    )


def confusion_card(item: dict[str, Any]) -> CardConfusion:
    predicted = item.get("predicted")
    return CardConfusion(
        expected=str(item["gold"]),
        predicted=None if predicted is None else str(predicted),
        count=int(item.get("count", 0)),
    )


def held_out(version: Version) -> dict[str, Any] | None:
    return (version.metrics or {}).get("eval") or None


def is_scored(version: Version) -> bool:
    return version.status == VersionStatus.READY and bool((held_out(version) or {}).get("scores"))


def accuracy_of(version: Version) -> float | None:
    return main_of(held_out(version), version_metric(version))


def cost_card(metrics: dict[str, Any] | None, prices: DevicePrices) -> CardCost | None:
    found = eval_cost(metrics, prices)
    if found is None:
        return None
    return CardCost(
        source=found.source,
        pool=found.pool,
        device=found.device,
        device_name=found.device_name,
        batch_size=found.batch_size,
        requests=found.requests,
        device_seconds_per_1k=rounded(found.device_seconds_per_1k, 3) or 0.0,
        prompt_tokens=rounded(found.prompt_tokens, 1),
        completion_tokens=rounded(found.completion_tokens, 1),
        hourly_price=rounded(found.hourly_price),
        currency=found.currency,
        per_1k=rounded(found.per_1k, 6),
    )


def comparison(version: Version, other: Version, prices: DevicePrices) -> CardComparison:
    metrics = other.metrics or {}
    mine, theirs = accuracy_of(version), accuracy_of(other)
    change = None if mine is None or theirs is None else rounded(mine - theirs)
    return CardComparison(
        number=other.number,
        kind=other.kind,
        same_data=other.dataset_version_id == version.dataset_version_id,
        held_out_accuracy=rounded(theirs),
        held_out_macro_f1=rounded(metric_values(held_out(other)).get("macro_f1")),
        test_accuracy=rounded(main_of(metrics.get("golden"), version_metric(other))),
        latency_p50_ms=rounded((metrics.get("latency") or {}).get("p50_ms"), 1),
        accuracy_change=change,
        latency_p95_ms=rounded((metrics.get("latency") or {}).get("p95_ms"), 1),
        cost=cost_card(metrics, prices),
    )


def prompt_baseline(model: Model, version: Version) -> Version | None:
    if version.kind == VersionKind.PROMPT:
        return None
    earlier = [
        other
        for other in model.versions
        if other.kind == VersionKind.PROMPT and other.number < version.number and is_scored(other)
    ]
    return max(
        earlier, key=lambda other: (other.dataset_version_id == version.dataset_version_id, other.number), default=None
    )


def previous_version(model: Model, version: Version) -> Version | None:
    earlier = [other for other in model.versions if other.number < version.number and is_scored(other)]
    return max(earlier, key=lambda other: other.number, default=None)


def evaluation_card(session: Session, model: Model, version: Version) -> CardEvaluation:
    metrics = version.metrics or {}
    split = held_out(version)
    latency = metrics.get("latency") or {}
    baseline = prompt_baseline(model, version)
    previous = previous_version(model, version)
    labels = label_report(split).get("labels")
    confusions = label_report(split).get("confusion")
    prices = load_prices(session)
    metric = version_metric(version)
    return CardEvaluation(
        scored=is_scored(version),
        held_out=score_card(split, metric),
        test_set=score_card(metrics.get("golden"), metric),
        latency_p50_ms=rounded(latency.get("p50_ms"), 1),
        latency_p95_ms=rounded(latency.get("p95_ms"), 1),
        per_label=None if labels is None else [label_score(item) for item in labels],
        confusion=None if confusions is None else [confusion_card(item) for item in confusions],
        run=run_card(session, version_job(model, version, JobKind.EVAL), metrics.get("device")),
        prompt_only=comparison(version, baseline, prices) if baseline is not None else None,
        previous=comparison(version, previous, prices) if previous is not None else None,
        cost=cost_card(metrics, prices),
    )


def listed(items: list[str]) -> str:
    return ", ".join(items)


def few_rows_limit(data: CardData) -> CardLimit | None:
    rare = [row for row in data.label_balance or [] if row.train < FEW_TRAINING_ROWS]
    if not rare:
        return None
    rare.sort(key=lambda row: (row.train, row.label))
    noun = "label has" if len(rare) == 1 else "labels have"
    return CardLimit(
        kind="few_training_rows",
        text=f"{len(rare)} {noun} fewer than {FEW_TRAINING_ROWS} training rows: "
        + listed([f"{row.label} ({row.train})" for row in rare])
        + ".",
        labels=[row.label for row in rare],
    )


def label_limits(evaluation: CardEvaluation) -> list[CardLimit]:
    scores = evaluation.per_label or []
    found: list[CardLimit] = []
    missing = [score.label for score in scores if score.support == 0]
    if missing:
        found.append(
            CardLimit(
                kind="unmeasured_labels",
                text=f"Not measured, with no held-out rows: {listed(missing)}.",
                labels=missing,
            )
        )
    weak = [score for score in scores if score.support > 0 and (score.recall or 0.0) < LOW_RECALL]
    if weak:
        weak.sort(key=lambda score: (score.recall or 0.0, score.label))
        found.append(
            CardLimit(
                kind="low_recall",
                text=f"Held-out recall is below {LOW_RECALL:.0%} for "
                + listed([f"{score.label} ({score.correct} of {score.support})" for score in weak])
                + ".",
                labels=[score.label for score in weak],
            )
        )
    return found


def score_limits(evaluation: CardEvaluation) -> list[CardLimit]:
    split = evaluation.held_out
    if split is None:
        return []
    found: list[CardLimit] = []
    if split.invalid_rate > 0:
        found.append(
            CardLimit(
                kind="invalid_outputs",
                text=f"{split.invalid_rate:.1%} of held-out answers were not one of the labels.",
            )
        )
    if 0 < split.examples < SMALL_HELD_OUT:
        found.append(
            CardLimit(
                kind="small_held_out",
                text=f"The held-out set has {split.examples} rows from the same data as training: one row moves "
                f"accuracy by {100 / split.examples:.1f} points, and inputs unlike the training data are not measured.",
            )
        )
    baseline = evaluation.prompt_only
    if baseline is not None and baseline.accuracy_change is not None and baseline.accuracy_change < 0:
        data = "on the same data" if baseline.same_data else "on other data"
        found.append(
            CardLimit(
                kind="below_prompt_only",
                text=f"Prompt-only v{baseline.number} scores higher on held-out rows {data}: "
                f"{baseline.held_out_accuracy or 0.0:.1%} against {split.accuracy:.1%}.",
            )
        )
    return found


def derived_limits(version: Version, data: CardData, evaluation: CardEvaluation) -> list[CardLimit]:
    found: list[CardLimit] = []
    if not evaluation.scored:
        reason = "scoring failed" if version.status == VersionStatus.FAILED else "scoring has not finished"
        found.append(CardLimit(kind="not_scored", text=f"Nothing on this card is measured yet: {reason}."))
    rare = few_rows_limit(data)
    if rare is not None:
        found.append(rare)
    found += label_limits(evaluation)
    found += score_limits(evaluation)
    leak = next((check for check in data.checks if check.check == "leakage" and check.status == "warning"), None)
    if leak is not None:
        found.append(CardLimit(kind="train_test_overlap", text=leak.detail))
    return found


def build_card(session: Session, settings: Settings, model: Model, version: Version, owner: str) -> ModelCard:
    events = card_events(session, model)
    history = history_of(events, model, version.number)
    creator = creator_of(events, model, version.number)
    if version.dataset_version is None:
        raise ConflictError(f"{model.slug}@{version.number} has no data yet, so there is nothing to put on a card")
    data = data_card(
        session, version.dataset_version, dataset_version_splits(session, settings, version.dataset_version)
    )
    evaluation = evaluation_card(session, model, version)
    return ModelCard(
        version=CardVersion(
            id=f"{model.slug}@{version.number}",
            slug=model.slug,
            name=model.name,
            number=version.number,
            kind=version.kind,
            status=version.status,
            created_at=stamp(version.created_at) or "",
            created_by=creator,
        ),
        purpose=CardPurpose(
            description=model.description, task=model.preset, labels=sorted(version.dataset_version.labels)
        ),
        base_model=base_card(session, model, version),
        training_data=data,
        training=training_card(session, model, version),
        evaluation=evaluation,
        limits=CardLimits(derived=derived_limits(version, data, evaluation), known_limits=version.known_limits or ""),
        use=CardUse(intended_use=version.intended_use or "", owner=creator or owner),
        approvals=[entry for entry in history if entry.kind == "deployed"],
        deployments=history,
    )
