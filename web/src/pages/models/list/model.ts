import type { ModelRow, ModelUsage, ModelVersionRow } from "~/api/client";
import type { components } from "~/api/schema";
import { failingShare } from "~/components/models/ModelMetrics";
import type { Tone } from "~/components/models/StatusText";
import { modelPageHref } from "~/lib/modelLinks";

export type Replica = components["schemas"]["ServingReplica"];

export type ListModel = {
    id: string;
    kind: "custom" | "base";
    key: string;
    name: string;
    row: ModelRow;
    variants: ModelRow[];
    versions: ModelVersionRow[];
    baseGroup: string | null;
    baseName: string | null;
};

export type StatusKind =
    | "teardown"
    | "health"
    | "unhealthy"
    | "failing"
    | "candidate"
    | "ready"
    | "failed"
    | "training"
    | "transfer"
    | "update"
    | "setup"
    | "starting"
    | "on"
    | "off";

export type StatusLine = {
    kind: StatusKind;
    text: string;
    tone: Tone | null;
    row: ModelRow;
    detail?: string;
    version?: number;
    progress?: number | null;
    jobId?: number | null;
};

const ATTENTION: StatusKind[] = [
    "teardown",
    "health",
    "unhealthy",
    "failing",
    "candidate",
    "failed",
    "training",
    "transfer",
    "update",
];
const PROBLEMS: StatusKind[] = ["teardown", "health", "transfer", "failed", "unhealthy", "failing"];
const FAILING_SHARE = 0.01;
const SAME = 0.0005;
export const SHOWN_VERSIONS = 5;
export const BASELINE_HINT = "Prompt only, not fine-tuned";

export function plural(count: number, word: string): string {
    return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function pct(value: number | null | undefined): string {
    return value === null || value === undefined ? "–" : `${(value * 100).toFixed(1)}%`;
}

export function points(delta: number): string {
    const value = Math.abs(delta * 100).toFixed(1);
    return delta > 0 ? `+${value}` : delta < 0 ? `−${value}` : "±0.0";
}

export function versionKey(slug: string, number: number): string {
    return `${slug}@${number}`;
}

export function variantKey(row: ModelRow): string {
    return `variant:${row.key}`;
}

export function baseGroupOf(row: ModelRow): string {
    return row.catalog_id ?? row.key;
}

function bySize(left: ModelRow, right: ModelRow): number {
    return (right.size_bytes ?? 0) - (left.size_bytes ?? 0) || left.key.localeCompare(right.key);
}

export function isDeployed(row: ModelRow): boolean {
    return row.deployment.state !== "not_deployed";
}

function leadOf(variants: ModelRow[]): ModelRow {
    return variants.find(isDeployed) ?? variants[0];
}

function baseGroups(rows: ModelRow[]): ListModel[] {
    const groups = new Map<string, ModelRow[]>();
    for (const row of rows.filter((item) => item.kind === "base")) {
        groups.set(baseGroupOf(row), [...(groups.get(baseGroupOf(row)) ?? []), row]);
    }
    return [...groups.entries()].map(([group, members]) => {
        const variants = [...members].sort(bySize);
        const lead = leadOf(variants);
        return {
            id: `group:${group}`,
            kind: "base",
            key: group,
            name: variants.length > 1 ? (lead.catalog_name ?? lead.name) : lead.name,
            row: lead,
            variants,
            versions: [],
            baseGroup: group,
            baseName: null,
        };
    });
}

export function listModels(rows: ModelRow[]): ListModel[] {
    const bases = new Map(rows.filter((row) => row.kind === "base").map((row) => [row.key, row]));
    const custom = rows
        .filter((row) => row.kind === "custom")
        .map((row): ListModel => {
            const base = bases.get(row.base_model ?? "");
            return {
                id: `custom:${row.key}`,
                kind: "custom",
                key: row.key,
                name: row.name,
                row,
                variants: [],
                versions: row.versions ?? [],
                baseGroup: base ? baseGroupOf(base) : row.base_model,
                baseName: base?.name ?? row.base_model,
            };
        });
    return [...custom, ...baseGroups(rows)];
}

export function childCount(model: ListModel): number {
    return model.kind === "base" ? model.variants.length : model.versions.length;
}

export function hrefOf(model: ListModel): string {
    return modelPageHref(model.row.key);
}

export function liveOf(model: ListModel): ModelVersionRow | undefined {
    return model.versions.find((version) => version.live);
}

export function scoredVersions(model: ListModel): ModelVersionRow[] {
    return model.versions
        .filter((version) => version.score !== null && version.score !== undefined)
        .sort((left, right) => left.number - right.number);
}

export function headlineOf(model: ListModel): ModelVersionRow | undefined {
    return (
        liveOf(model) ??
        model.versions.find((version) => version.score !== null && version.score !== undefined)
    );
}

export function deltaOf(model: ListModel, version: ModelVersionRow): number | null {
    const live = liveOf(model);
    if (!live || live.number === version.number || live.score == null || version.score == null) {
        return null;
    }
    return version.score - live.score;
}

function goesLive(version: ModelVersionRow): boolean {
    return (
        version.status === "ready" &&
        !version.base_refusal &&
        (version.promotion?.passed === true || version.was_live === true)
    );
}

export function canMakeLive(model: ListModel, version: ModelVersionRow): boolean {
    return !model.row.teardown && !version.live && goesLive(version);
}

export function beatsLive(model: ListModel, version: ModelVersionRow): boolean {
    const delta = deltaOf(model, version);
    return (
        goesLive(version) && version.promotion?.passed === true && delta !== null && delta > SAME
    );
}

export function candidateOf(model: ListModel): ModelVersionRow | undefined {
    return model.versions
        .filter((version) => beatsLive(model, version))
        .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))[0];
}

function trainedReady(model: ListModel): ModelVersionRow | undefined {
    const serveOnly = Boolean(model.row.serve_only);
    return model.versions.find(
        (version) =>
            goesLive(version) &&
            version.promotion?.passed === true &&
            (version.kind === "lora" || serveOnly),
    );
}

export function busyVersion(model: ListModel): ModelVersionRow | undefined {
    return model.versions.find(
        (version) => version.status === "training" || version.status === "evaluating",
    );
}

export function isBaseline(version: Pick<ModelVersionRow, "number" | "kind">): boolean {
    return version.kind === "prompt" && version.number === 0;
}

export function versionName(version: Pick<ModelVersionRow, "number" | "kind">): string {
    return isBaseline(version) ? `v${version.number} · Baseline` : `v${version.number}`;
}

export type ScoreNote = { kind: "beats"; delta: number } | { kind: "below"; reason: string };

export function scoreNote(model: ListModel, version: ModelVersionRow): ScoreNote | null {
    if (version.score == null || version.live || isBaseline(version)) {
        return null;
    }
    if (version.promotion?.passed === false) {
        const missed = version.promotion.checks.filter((check) => !check.passed);
        const reason = missed.map((check) => `${check.name}: ${check.detail}`).join("; ");
        return { kind: "below", reason: reason || "The promotion rule was not met." };
    }
    const delta = deltaOf(model, version);
    return delta !== null && delta > SAME ? { kind: "beats", delta } : null;
}

function percentage(value: number | null | undefined): string {
    return value === null || value === undefined ? "" : ` ${Math.round(value * 100)}%`;
}

function lastPart(label: string): string {
    return label.split(" · ").at(-1) ?? label;
}

function failing(row: ModelRow): StatusLine | null {
    const usage = row.usage;
    if (!isDeployed(row) || failingShare(usage) < FAILING_SHARE) {
        return null;
    }
    return {
        kind: "failing",
        text: `${Math.round(failingShare(usage) * 100)}% of requests failing`,
        tone: "destructive",
        detail: `${usage?.failed ?? 0} of ${usage?.total ?? 0} requests in the last 7 days failed.`,
        row,
    };
}

function serving(row: ModelRow): StatusLine | null {
    if (row.teardown) {
        return { kind: "teardown", text: row.teardown.label, tone: "info", row };
    }
    if (row.health) {
        return { kind: "health", text: row.health.label, tone: "destructive", row };
    }
    if (row.deployment.state === "unhealthy") {
        return {
            kind: "unhealthy",
            text: "Deployment unhealthy",
            tone: "destructive",
            detail: "The engine serving it does not answer health checks.",
            row,
        };
    }
    return failing(row);
}

function deployedLine(row: ModelRow): StatusLine {
    if (row.deployment.state === "starting") {
        return { kind: "starting", text: lastPart(row.deployment.label), tone: "info", row };
    }
    if (isDeployed(row)) {
        return { kind: "on", text: "Deployed", tone: "success", row };
    }
    return { kind: "off", text: "Not deployed", tone: null, row };
}

function customLine(model: ListModel): StatusLine {
    const row = model.row;
    const problem = serving(row);
    if (problem) {
        return problem;
    }
    const best = candidateOf(model);
    if (best) {
        return {
            kind: "candidate",
            text: `v${best.number} beats live ${points(deltaOf(model, best) ?? 0)}`,
            tone: "success",
            version: best.number,
            row,
        };
    }
    const newest = model.versions[0];
    if (newest?.status === "failed") {
        return {
            kind: "failed",
            text: `v${newest.number} failed`,
            tone: "destructive",
            detail: newest.error || "The job failed without a message.",
            version: newest.number,
            jobId: newest.job_id,
            row,
        };
    }
    const busy = busyVersion(model);
    if (busy) {
        const verb = busy.status === "training" ? "training" : "scoring";
        return {
            kind: "training",
            text: `v${busy.number} ${verb}${percentage(busy.progress)}`,
            tone: "info",
            version: busy.number,
            progress: busy.progress,
            jobId: busy.job_id,
            row,
        };
    }
    if (row.activity.state === "failed") {
        return {
            kind: "failed",
            text: row.activity.label,
            tone: "destructive",
            detail: row.error || "The last job failed without a message.",
            jobId: row.activity.job_id,
            row,
        };
    }
    if (row.activity.state === "needs_examples") {
        return { kind: "setup", text: "Needs data", tone: null, row };
    }
    const ready = liveOf(model) ? undefined : trainedReady(model);
    if (ready) {
        return {
            kind: "ready",
            text: `v${ready.number} ready`,
            tone: "success",
            version: ready.number,
            row,
        };
    }
    return deployedLine(row);
}

const TRANSFERS = new Set(["downloading", "importing"]);

export function variantLine(row: ModelRow): StatusLine {
    if (row.teardown || row.health) {
        return serving(row) ?? deployedLine(row);
    }
    if (TRANSFERS.has(row.availability.state)) {
        const label = row.availability.state === "downloading" ? "Downloading" : "Importing";
        return {
            kind: "transfer",
            text: `${label}${percentage(row.availability.progress)}`,
            tone: "info",
            progress: row.availability.progress,
            jobId: row.availability.job_id,
            row,
        };
    }
    if (row.activity.state === "running" || row.activity.state === "queued") {
        return {
            kind: "transfer",
            text: `${row.activity.label}${percentage(row.activity.progress)}`,
            tone: "info",
            progress: row.activity.progress,
            jobId: row.activity.job_id,
            row,
        };
    }
    if (row.activity.state === "failed") {
        return {
            kind: "failed",
            text: row.activity.label,
            tone: "destructive",
            detail: row.error || "The last job failed without a message.",
            jobId: row.activity.job_id,
            row,
        };
    }
    const problem = serving(row);
    if (problem) {
        return problem;
    }
    if (row.availability.state === "not_downloaded") {
        return { kind: "off", text: "Not downloaded", tone: null, row };
    }
    return deployedLine(row);
}

function baseLine(model: ListModel): StatusLine {
    const lines = model.variants.map(variantLine);
    const problem = lines.find((line) => PROBLEMS.includes(line.kind));
    if (problem) {
        return problem;
    }
    const update = model.variants.find(
        (row) => row.update_available && row.availability.state === "available",
    );
    if (update) {
        const single = model.variants.length === 1;
        return {
            kind: "update",
            text: single
                ? "Update available"
                : `${update.variant_label ?? update.name} has an update`,
            tone: "info",
            row: update,
        };
    }
    return model.variants.length === 1 ? lines[0] : deployedLine(model.row);
}

export function statusLine(model: ListModel): StatusLine {
    return model.kind === "custom" ? customLine(model) : baseLine(model);
}

export function attention(model: ListModel): boolean {
    return ATTENTION.includes(statusLine(model).kind);
}

export function deployed(model: ListModel): boolean {
    return model.kind === "custom" ? isDeployed(model.row) : model.variants.some(isDeployed);
}

export function replicasOf(model: ListModel): Replica[] {
    if (model.kind === "custom") {
        return isDeployed(model.row) ? (model.row.replicas ?? []) : [];
    }
    return model.variants.filter(isDeployed).flatMap((row) => row.replicas ?? []);
}

function sumOf(values: number[][]): number[] {
    return (values[0] ?? []).map((_, index) =>
        values.reduce((sum, list) => sum + (list[index] ?? 0), 0),
    );
}

function latest(values: (string | null | undefined)[]): string | null {
    return (
        values
            .filter((value): value is string => Boolean(value))
            .sort()
            .at(-1) ?? null
    );
}

function highest(values: (number | null | undefined)[]): number | null {
    const found = values.filter((value): value is number => typeof value === "number");
    return found.length > 0 ? Math.max(...found) : null;
}

export function usageOf(model: ListModel): ModelUsage | null {
    if (model.kind === "custom") {
        return model.row.usage ?? null;
    }
    const used = model.variants.map((row) => row.usage).filter((usage) => usage != null);
    if (used.length < 2) {
        return used[0] ?? null;
    }
    const total = (pick: (usage: ModelUsage) => number) =>
        used.reduce((sum, usage) => sum + pick(usage), 0);
    return {
        days: used[0].days,
        daily: sumOf(used.map((usage) => usage.daily)),
        total: total((usage) => usage.total),
        previous: total((usage) => usage.previous),
        failed: total((usage) => usage.failed),
        errors: total((usage) => usage.errors ?? 0),
        last_at: latest(used.map((usage) => usage.last_at)) ?? used[0].last_at,
        p50_ms: highest(used.map((usage) => usage.p50_ms)),
        p95_ms: highest(used.map((usage) => usage.p95_ms)),
    };
}

export function costOf(model: ListModel): ModelVersionRow["cost"] {
    return model.kind === "custom" ? (headlineOf(model)?.cost ?? null) : null;
}

export function updatedAt(model: ListModel): string {
    return latest([model.row.updated_at, ...model.variants.map((row) => row.updated_at)]) ?? "";
}

export function shownVersions(model: ListModel): ModelVersionRow[] {
    const pinned = model.versions.filter((version) => version.live || beatsLive(model, version));
    const rest = model.versions.filter((version) => !pinned.includes(version));
    const picked = [...pinned, ...rest.slice(0, Math.max(0, SHOWN_VERSIONS - pinned.length))];
    return model.versions.filter((version) => picked.includes(version));
}

export function versionState(version: ModelVersionRow): { label: string; tone: Tone } {
    if (version.status === "training") {
        return { label: "Training", tone: "info" };
    }
    if (version.status === "evaluating") {
        return { label: "Scoring", tone: "info" };
    }
    if (version.status === "failed") {
        return { label: "Failed", tone: "destructive" };
    }
    if (version.status === "deleting") {
        return { label: "Deleting", tone: "destructive" };
    }
    return version.live ? { label: "Live", tone: "success" } : { label: "Ready", tone: "neutral" };
}

export function modelText(model: ListModel): string {
    return [
        model.name,
        model.row.description,
        model.key,
        model.baseName ?? "",
        ...model.row.tags,
        ...model.variants.map((row) => `${row.name} ${row.key}`),
    ]
        .join(" ")
        .toLowerCase();
}

export function versionMatches(version: ModelVersionRow, text: string): boolean {
    const number = /^v(\d+)$/.exec(text);
    if (number) {
        return version.number === Number(number[1]);
    }
    return `${versionName(version)} ${versionState(version).label} job #${version.job_id ?? ""}`
        .toLowerCase()
        .includes(text);
}

export function variantMatches(row: ModelRow, text: string): boolean {
    const state = isDeployed(row) ? "deployed" : "not deployed";
    return `${row.variant_label ?? ""} ${row.key} ${state}`.toLowerCase().includes(text);
}

export function childHits(model: ListModel, text: string): number {
    if (!text) {
        return 0;
    }
    return model.kind === "base"
        ? model.variants.filter((row) => variantMatches(row, text)).length
        : model.versions.filter((version) => versionMatches(version, text)).length;
}

export function matchesText(model: ListModel, text: string): boolean {
    return !text || modelText(model).includes(text) || childHits(model, text) > 0;
}
