import hashlib
import json
import re
from collections.abc import Iterable
from typing import Any

from minibrain.api.card_schemas import (
    CANONICAL_FORM,
    CardComparison,
    CardCost,
    CardData,
    CardEvent,
    CardOrigin,
    CardRun,
    CardScore,
    ModelCard,
)

KINDS = {"lora": "Trained (LoRA)", "prompt": "Prompt-only"}
USE_GROUPS = {
    "commercial": "Commercial use allowed",
    "restricted": "Commercial use with conditions",
    "non-commercial": "Non-commercial only",
    "unknown": "Not known",
}
STATUSES = {"ok": "Passed", "warning": "Warning", "blocked": "Blocked", "off": "Off", "skipped": "Skipped"}
NONE = "\N{EN DASH}"
VERIFY = (
    'python3 -c \'import hashlib,json,sys; c=json.load(open(sys.argv[1]))["card"]; '
    'print(hashlib.sha256(json.dumps(c,sort_keys=True,separators=(",",":"),ensure_ascii=False)'
    ".encode()).hexdigest())' card.json"
)

Facts = list[tuple[str, Any]]


def plain(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: plain(item) for key, item in value.items()}
    if isinstance(value, list):
        return [plain(item) for item in value]
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            return None
        return int(value) if value.is_integer() else value
    return value


def card_data(card: ModelCard) -> dict[str, Any]:
    return plain(card.model_dump(mode="json"))


def canonical(data: dict[str, Any]) -> bytes:
    return json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def digest(data: dict[str, Any]) -> str:
    return hashlib.sha256(canonical(data)).hexdigest()


def export_json(data: dict[str, Any]) -> str:
    envelope = {"card": data, "sha256": digest(data), "canonical_form": CANONICAL_FORM}
    return json.dumps(envelope, sort_keys=True, indent=2, ensure_ascii=False) + "\n"


def when(value: str | None) -> str:
    return value.replace("T", " ").replace("Z", " UTC") if value else NONE


def cell(value: Any) -> str:
    if value is None or value == "":
        return NONE
    return " ".join(str(value).split()).replace("|", "\\|")


def code(value: str | None) -> str:
    return f"`{value}`" if value else NONE


def percent(value: float | None) -> str:
    return NONE if value is None else f"{value:.1%}"


def decimal(value: float | None) -> str:
    return NONE if value is None else f"{value:.3f}"


def ms(value: float | None) -> str:
    return NONE if value is None else f"{round(value):,} ms"


def change(value: float | None) -> str:
    if value is None:
        return NONE
    points = value * 100
    return "Same" if round(points, 1) == 0 else f"{points:+.1f} pts"


def duration(seconds: float | None) -> str:
    if seconds is None:
        return NONE
    minutes, rest = divmod(round(seconds), 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours} h {minutes} min"
    return f"{minutes} min {rest} s" if minutes else f"{rest} s"


def device_time(cost: CardCost | None) -> str:
    if cost is None:
        return NONE
    value = cost.device_seconds_per_1k
    shown = f"{value:.3g} s" if value < 60 else duration(value)
    return f"{shown} of {'CPU' if cost.device == 'cpu' else 'GPU'} time"


def money(amount: float, currency: str | None) -> str:
    shown = f"{amount:,.2f}" if amount >= 1 else f"{amount:.3g}"
    return f"{shown} {currency or ''}".strip()


def cost_text(cost: CardCost | None) -> str:
    if cost is None:
        return NONE
    if cost.per_1k is None:
        return f"No price per hour set for pool {cost.pool or NONE}"
    rate = money(cost.hourly_price or 0.0, cost.currency)
    return f"{money(cost.per_1k, cost.currency)} at {rate} per device hour"


def tokens_text(cost: CardCost | None) -> str:
    if cost is None or cost.prompt_tokens is None or cost.completion_tokens is None:
        return NONE
    return f"{cost.prompt_tokens:,.1f} in and {cost.completion_tokens:,.1f} out"


def measured_on(cost: CardCost | None) -> str:
    if cost is None:
        return NONE
    pool = f", pool {cost.pool}" if cost.pool else ""
    return f"{cost.requests:,} held-out requests in batches of {cost.batch_size or 1} on {cost.device_name}{pool}"


def table(header: list[str], rows: Iterable[list[Any]]) -> list[str]:
    lines = ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
    return lines + ["| " + " | ".join(cell(value) for value in row) + " |" for row in rows]


def facts(rows: Facts) -> list[str]:
    return table(["Field", "Value"], ([label, value] for label, value in rows))


def fence(text: str, language: str) -> list[str]:
    longest = max((len(run) for run in re.findall(r"`+", text)), default=0)
    marks = "`" * max(3, longest + 1)
    return [f"{marks}{language}", text, marks]


def paragraph(text: str, empty: str) -> list[str]:
    return [text.strip() if text.strip() else empty]


def section(title: str, body: list[str]) -> list[str]:
    return [title, "", *body, ""]


def purpose_section(card: ModelCard) -> list[str]:
    purpose = card.purpose
    rows: Facts = [("Task", purpose.task.capitalize()), ("Labels", ", ".join(purpose.labels))]
    description = paragraph(purpose.description, "No description.")
    return section("## Purpose", [*description, "", *facts(rows)])


def use_section(card: ModelCard) -> list[str]:
    body = [*paragraph(card.use.intended_use, "Not written yet."), "", f"Owner: {card.use.owner}"]
    return section("## Intended use and owner", body)


def base_section(card: ModelCard) -> list[str]:
    base = card.base_model
    source = "recorded when training started" if base.content_hash_recorded else "the base model's current files"
    accepted = f"{base.licence_accepted_by}, {when(base.licence_accepted_at)}" if base.licence_accepted_by else None
    rows: Facts = [
        ("Name", base.name if base.name == base.key else f"{base.name} ({base.key})"),
        ("Publisher", base.publisher),
        ("Repository", base.repo),
        ("Revision", code(base.revision)),
        ("Content hash", f"{code(base.content_hash)} ({source})" if base.content_hash else None),
        ("Licence", base.licence_name or base.licence),
        ("Commercial use", USE_GROUPS[base.licence_use]),
        ("Licence accepted by", accepted),
    ]
    return section("## Base model", facts(rows))


def balance_lines(card: ModelCard) -> list[str]:
    balance = card.training_data.label_balance
    if balance is None:
        return ["Not available: the data file could not be read."]
    header = ["Label", "Rows", "Share", "Train", "Held-out", "Test"]
    return table(header, ([r.label, r.rows, percent(r.share), r.train, r.held_out, r.test] for r in balance))


def source_lines(card: ModelCard) -> list[str]:
    sources = card.training_data.sources
    if not sources:
        return ["No source fingerprints were recorded with this data."]
    header = ["Table", "Source", "Kind", "Fingerprint"]
    return table(header, ([s.table, s.name, s.kind, code(s.fingerprint)] for s in sources))


def check_lines(card: ModelCard) -> list[str]:
    data = card.training_data
    if not data.checks:
        return ["No checks were recorded with this data."]
    rows = ([c.title, STATUSES.get(c.status, c.status), c.detail] for c in data.checks)
    lines = table(["Check", "Result", "Detail"], rows)
    found = data.personal_data
    return [*lines, "", f"Personal data: {found.detail}"] if found and found.status == "warning" else lines


def version_text(data: CardData) -> str | None:
    if data.dataset_version is None:
        return None
    if data.dataset_version_feedback_rows:
        return f"{data.dataset_version}, plus {data.dataset_version_feedback_rows:,} rows from feedback"
    return str(data.dataset_version)


def data_section(card: ModelCard) -> list[str]:
    data = card.training_data
    splits = data.splits
    split_text = (
        f"train {splits.train:,}, held-out {splits.held_out:,}, test {splits.test:,}, few-shot {splits.few_shot:,}"
    )
    rows: Facts = [
        ("Dataset", f"{data.dataset_name} ({data.dataset_slug})" if data.dataset_slug else None),
        ("Dataset version", version_text(data)),
        ("SHA-256", code(data.dataset_version_hash)),
        ("Rows", f"{data.dataset_version_rows:,}"),
        ("Saved", when(data.dataset_version_taken_at)),
        ("Splits", split_text),
    ]
    lines = section("## Training data", facts(rows))
    lines = lines + section("### Label balance", balance_lines(card))
    lines = lines + section("### Sources", source_lines(card))
    lines = lines + section("### Checks", check_lines(card))
    if data.query:
        lines = lines + section("### Query", fence(data.query, "sql"))
    return lines


def run_rows(run: CardRun | None) -> Facts:
    if run is None:
        return [("Job", "Not recorded")]
    return [
        ("Job", run.job_id),
        ("Started", when(run.started_at)),
        ("Finished", when(run.finished_at)),
        ("Duration", duration(run.duration_seconds)),
        ("Device", run.device),
        ("Machine", run.machine),
    ]


def origin_text(origin: CardOrigin | None) -> str | None:
    return f"{origin.name} v{origin.number}" if origin is not None else None


def training_section(card: ModelCard) -> list[str]:
    training = card.training
    recipe = training.recipe
    origin = origin_text(training.duplicated_from)
    if training.method != "lora" or recipe is None:
        text = (
            "Prompt-only: no weights were trained. The base model answers with the task prompt, the label list and "
            f"{training.few_shot_examples or 0} few-shot examples from the training split."
        )
        return section("## Training", [text] + ([f"Duplicated from {origin}."] if origin else []))
    rows: Facts = [
        *([("Duplicated from", origin)] if origin else []),
        ("Method", "LoRA adapter"),
        ("Strategy", recipe.strategy),
        ("Rows trained on", training.examples),
        ("Row limit", recipe.max_rows),
        ("Epochs", recipe.epochs),
        ("LoRA rank and alpha", f"{recipe.rank} and {recipe.alpha}" if recipe.rank is not None else None),
        ("Learning rate", recipe.learning_rate),
        ("Sequence length", recipe.seq_len),
        ("Micro-batch", recipe.micro_batch),
        ("Gradient accumulation", recipe.grad_accum),
        ("Final training loss", training.train_loss),
    ]
    return section("## Training", facts(rows + run_rows(training.run)))


def score_text(score: CardScore | None) -> str:
    return NONE if score is None else f"{percent(score.accuracy)} of {score.examples:,} rows"


def compared(card: ModelCard) -> list[tuple[str, CardComparison]]:
    evaluation = card.evaluation
    baseline = evaluation.prompt_only
    previous = evaluation.previous
    found: list[tuple[str, CardComparison]] = []
    if baseline is not None:
        found.append((f"Prompt-only v{baseline.number}", baseline))
    if previous is not None and (baseline is None or previous.number != baseline.number):
        found.append((f"Previous v{previous.number}", previous))
    return found


def compare_lines(card: ModelCard) -> list[str]:
    others = compared(card)
    if not others:
        return ["No earlier scored version to compare with."]
    evaluation = card.evaluation
    held = evaluation.held_out
    test = evaluation.test_set
    kind = card.version.kind
    header = ["", f"This version (v{card.version.number})", *(name for name, _ in others)]
    columns = [comparison for _, comparison in others]
    rows = [
        ["Kind", KINDS.get(kind, kind), *(KINDS.get(o.kind, o.kind) for o in columns)],
        ["Same data", NONE, *("Yes" if o.same_data else "No" for o in columns)],
        [
            "Held-out accuracy",
            percent(held.accuracy if held else None),
            *(percent(o.held_out_accuracy) for o in columns),
        ],
        ["Change", NONE, *(change(o.accuracy_change) for o in columns)],
        [
            "Held-out macro F1",
            decimal(held.macro_f1 if held else None),
            *(decimal(o.held_out_macro_f1) for o in columns),
        ],
        ["Test set accuracy", percent(test.accuracy if test else None), *(percent(o.test_accuracy) for o in columns)],
        ["Latency p50", ms(evaluation.latency_p50_ms), *(ms(o.latency_p50_ms) for o in columns)],
        ["Latency p95", ms(evaluation.latency_p95_ms), *(ms(o.latency_p95_ms) for o in columns)],
        ["Device time per 1,000 requests", device_time(evaluation.cost), *(device_time(o.cost) for o in columns)],
        ["Cost per 1,000 requests", cost_text(evaluation.cost), *(cost_text(o.cost) for o in columns)],
    ]
    return table(header, rows)


def label_lines(card: ModelCard) -> list[str]:
    scores = card.evaluation.per_label
    if scores is None:
        return ["Per-label scores were not recorded for this version."]
    header = ["Label", "Held-out rows", "Predicted", "Precision", "Recall", "F1"]
    rows = ([s.label, s.support, s.predicted, percent(s.precision), percent(s.recall), decimal(s.f1)] for s in scores)
    return table(header, rows)


def confusion_lines(card: ModelCard) -> list[str]:
    found = card.evaluation.confusion
    if found is None:
        return ["Confusions were not recorded for this version."]
    if not found:
        return ["Every held-out row was answered correctly."]
    return table(["Expected", "Answered", "Rows"], ([c.expected, c.predicted or "Not a label", c.count] for c in found))


def evaluation_section(card: ModelCard) -> list[str]:
    evaluation = card.evaluation
    held = evaluation.held_out
    rows: Facts = [
        ("Held-out rows", held.examples if held else None),
        ("Held-out accuracy", percent(held.accuracy) if held else None),
        ("Held-out macro F1", decimal(held.macro_f1) if held else None),
        ("Answers not a label", percent(held.invalid_rate) if held else None),
        ("Test set", score_text(evaluation.test_set)),
        ("Latency p50 and p95", f"{ms(evaluation.latency_p50_ms)} and {ms(evaluation.latency_p95_ms)}"),
        ("Device time per 1,000 requests", device_time(evaluation.cost)),
        ("Cost per 1,000 requests", cost_text(evaluation.cost)),
        ("Tokens per request", tokens_text(evaluation.cost)),
        ("Cost measured on", measured_on(evaluation.cost)),
    ]
    intro = [] if evaluation.scored else ["Not scored yet.", ""]
    lines = section("## Evaluation", intro + facts(rows + run_rows(evaluation.run)))
    lines = lines + section("### Per label", label_lines(card))
    lines = lines + section("### Confusions", confusion_lines(card))
    return lines + section("### Comparison", compare_lines(card))


def limits_section(card: ModelCard) -> list[str]:
    derived = [f"- {limit.text}" for limit in card.limits.derived] or ["None found."]
    known = paragraph(card.limits.known_limits, "None written.")
    measured = section("### Derived from the data and scores", derived)
    return ["## Limits", "", *measured, *section("### Known limits", known)]


def events_lines(events: list[CardEvent], empty: str) -> list[str]:
    if not events:
        return [empty]
    rows = ([when(e.at), e.actor, e.summary, e.audit_id] for e in events)
    return table(["When", "Who", "Event", "Audit event"], rows)


def approvals_section(card: ModelCard) -> list[str]:
    approvals = events_lines(card.approvals, "Not deployed: the audit log records no deployment of this version.")
    history = events_lines(card.deployments, "No deployment changes recorded in the audit log.")
    return section("## Approvals", approvals) + section("## Deployment history", history)


def integrity_section(sha256: str) -> list[str]:
    check = "The JSON export carries the same card and digest; check it with:"
    return section(
        "## Integrity", [f"SHA-256 of the canonical JSON card: `{sha256}`", "", check, "", *fence(VERIFY, "sh")]
    )


def heading(card: ModelCard) -> list[str]:
    version = card.version
    created = f"created {when(version.created_at)}"
    if version.created_by:
        created += f" by {version.created_by}"
    summary = f"`{version.id}` · {KINDS.get(version.kind, version.kind)} · {version.status} · {created}"
    note = "Generated by minibrain from the stored version, its dataset version, its scores and the audit log."
    return section(f"# Model card: {version.name} v{version.number}", [summary, "", note])


def export_markdown(card: ModelCard, sha256: str) -> str:
    parts = [
        heading(card),
        purpose_section(card),
        use_section(card),
        base_section(card),
        data_section(card),
        training_section(card),
        evaluation_section(card),
        limits_section(card),
        approvals_section(card),
        integrity_section(sha256),
    ]
    lines = [line for part in parts for line in part]
    return "\n".join(lines).rstrip() + "\n"
