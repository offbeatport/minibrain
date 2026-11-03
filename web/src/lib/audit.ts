import type { components } from "~/api/schema";
import { listHref } from "~/lib/listSearch";
import { bytes, exactTime } from "~/lib/time";

export type AuditEvent = components["schemas"]["AuditInfo"];
type PolicyInfo = components["schemas"]["PolicyInfo"];
type Detail = Record<string, unknown>;

export const AUDIT_PATH = "/settings/audit";
export const AUDIT_KEYS = [
    "q",
    "action",
    "actor",
    "from",
    "to",
    "before",
    "after",
    "event",
] as const;
export type AuditSearch = Partial<Record<(typeof AUDIT_KEYS)[number], string>>;

const ACTIONS: Record<string, string> = {
    "audit.prune": "Audit events deleted",
    "key.create": "API key created",
    "key.revoke": "API key revoked",
    "key.update": "API key changed",
    "model.delete": "Model deleted",
    "model.evict": "Model files removed",
    "model.pin": "Model pinned",
    "model.reimport": "Model re-imported",
    "model.relocate": "Model moved",
    "model.repair": "Model repaired",
    "model.unpin": "Model unpinned",
    "model.verify": "Model files checked",
    "policy.update": "Policy changed",
    "settings.model_cache": "Model cache changed",
    "storage.update": "Storage changed",
    "version.delete": "Version deleted",
};

const KEY_LABELS: Record<string, string> = {
    budget_bytes: "Budget",
    days: "Retention",
    deleted: "Events deleted",
    files: "Files",
    from: "Before",
    job: "Job",
    kept: "Files kept at",
    kind: "Kind",
    last_used_at: "Last used",
    models: "Models",
    name: "Name",
    older_than: "Older than",
    size_bytes: "Size",
    source: "Source",
    status: "Status",
    to: "After",
    trigger: "Trigger",
    versions: "Versions",
};

const STORAGE_KINDS: Record<string, string> = { local: "Local folder", s3: "S3-compatible bucket" };
const VERSION_KINDS: Record<string, string> = { lora: "LoRA version", prompt: "Prompt version" };

function sentence(text: string): string {
    const words = text.replaceAll(/[._]+/g, " ").trim();
    return words ? words[0].toUpperCase() + words.slice(1) : text;
}

export function actionLabel(action: string): string {
    return ACTIONS[action] ?? sentence(action);
}

export function actorLabel(actor: string): string {
    return actor === "system" ? "System" : actor;
}

export function keyLabel(key: string): string {
    return KEY_LABELS[key] ?? sentence(key.replace(/_(at|bytes)$/, ""));
}

function isRecord(value: unknown): value is Detail {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function plainValue(value: unknown, policy?: PolicyInfo, key = ""): string {
    if (value === null || value === undefined || value === "") {
        return "None";
    }
    if (typeof value === "boolean") {
        return value ? "On" : "Off";
    }
    if (typeof value === "number") {
        if (key.endsWith("_bytes")) {
            return bytes(value);
        }
        if (key === "days" || key.endsWith("_days")) {
            return value === 0 ? "Forever" : `${value.toLocaleString()} days`;
        }
        return value.toLocaleString();
    }
    if (Array.isArray(value)) {
        return value.length ? value.map((item) => plainValue(item, policy)).join(", ") : "None";
    }
    if (isRecord(value)) {
        return Object.entries(value)
            .map(([name, item]) => `${keyLabel(name)}: ${plainValue(item, undefined, name)}`)
            .join("; ");
    }
    const text = String(value);
    if (key.endsWith("_at") || key === "older_than") {
        return exactTime(text);
    }
    return policy?.choices.find((choice) => choice.value === text)?.label ?? text;
}

export function policyFor(
    event: AuditEvent,
    policies: Map<string, PolicyInfo>,
): PolicyInfo | undefined {
    return event.action === "policy.update" ? policies.get(event.target) : undefined;
}

export function targetLabel(event: AuditEvent, policies: Map<string, PolicyInfo>): string {
    const detail = event.detail as Detail;
    const policy = policyFor(event, policies);
    if (policy) {
        return policy.label;
    }
    if (event.action === "storage.update") {
        return "Artifact storage";
    }
    if (event.action === "audit.prune") {
        return "Audit log";
    }
    if (event.action === "settings.model_cache") {
        return "Model cache";
    }
    return typeof detail.name === "string" && detail.name ? detail.name : event.target;
}

export type Change = { field: string; before: string; after: string };

export function changesOf(event: AuditEvent, policies: Map<string, PolicyInfo>): Change[] {
    const detail = event.detail as Detail;
    if (!("from" in detail) || !("to" in detail)) {
        return [];
    }
    const policy = policyFor(event, policies);
    if (event.action === "storage.update") {
        return [
            {
                field: "Kind",
                before: STORAGE_KINDS[String(detail.from)] ?? plainValue(detail.from),
                after: STORAGE_KINDS[String(detail.to)] ?? plainValue(detail.to),
            },
        ];
    }
    if (isRecord(detail.from) && isRecord(detail.to)) {
        const before = detail.from;
        const after = detail.to;
        const names = [...new Set([...Object.keys(before), ...Object.keys(after)])];
        return names
            .filter((name) => JSON.stringify(before[name]) !== JSON.stringify(after[name]))
            .map((name) => ({
                field: keyLabel(name),
                before: plainValue(before[name], undefined, name),
                after: plainValue(after[name], undefined, name),
            }));
    }
    const field = policy?.label ?? (event.action === "model.relocate" ? "Location" : "Value");
    return [
        {
            field,
            before: plainValue(detail.from, policy, event.target),
            after: plainValue(detail.to, policy, event.target),
        },
    ];
}

function listChange(before: unknown[], after: unknown[], policy?: PolicyInfo): string {
    const added = after.filter((item) => !before.includes(item));
    const removed = before.filter((item) => !after.includes(item));
    const parts = [
        added.length > 0 ? `Added ${plainValue(added, policy)}` : "",
        removed.length > 0 ? `Removed ${plainValue(removed, policy)}` : "",
    ].filter(Boolean);
    return parts.join("; ") || "No change";
}

const SUMMARIES: Record<string, (detail: Detail) => string> = {
    "audit.prune": (detail) =>
        `${plainValue(detail.deleted)} events older than ${plainValue(detail.days, undefined, "days")}`,
    "model.delete": (detail) =>
        typeof detail.size_bytes === "number" ? `Freed ${bytes(detail.size_bytes)}` : "Deleted",
    "model.evict": (detail) =>
        typeof detail.size_bytes === "number"
            ? `Freed ${bytes(detail.size_bytes)} to stay under the cache budget`
            : "Removed to stay under the cache budget",
    "model.reimport": (detail) => `From ${plainValue(detail.source)}`,
    "model.relocate": (detail) => `${plainValue(detail.from)} → ${plainValue(detail.to)}`,
    "model.repair": (detail) => `From ${plainValue(detail.source)}`,
    "model.verify": (detail) => `${plainValue(detail.files)} files`,
    "version.delete": (detail) => VERSION_KINDS[String(detail.kind)] ?? "Version",
};

export function summaryOf(event: AuditEvent, policies: Map<string, PolicyInfo>): string {
    const detail = event.detail as Detail;
    const special = SUMMARIES[event.action];
    if (special) {
        return special(detail);
    }
    if (event.action.startsWith("key.")) {
        const models = Array.isArray(detail.models) ? detail.models : [];
        return models.length ? `For ${plainValue(models)}` : "For no models";
    }
    if (Array.isArray(detail.from) && Array.isArray(detail.to)) {
        return listChange(detail.from, detail.to, policyFor(event, policies));
    }
    const changes = changesOf(event, policies);
    if (changes.length > 0) {
        return changes
            .map((change) =>
                changes.length > 1 || isRecord(detail.from)
                    ? `${change.field}: ${change.before} → ${change.after}`
                    : `${change.before} → ${change.after}`,
            )
            .join("; ");
    }
    return Object.entries(detail)
        .filter(([name]) => name !== "name")
        .slice(0, 3)
        .map(([name, value]) => `${keyLabel(name)}: ${plainValue(value, undefined, name)}`)
        .join("; ");
}

export function otherFields(event: AuditEvent): [string, unknown][] {
    const detail = event.detail as Detail;
    const changed = "from" in detail && "to" in detail;
    return Object.entries(detail).filter(
        ([name]) => !(changed && (name === "from" || name === "to")),
    );
}

export function auditHref(search: AuditSearch): string {
    return listHref(AUDIT_PATH, search);
}

function startOfDay(day: string, offset = 0): string | undefined {
    const [year, month, date] = day.split("-").map(Number);
    if (!year || !month || !date) {
        return undefined;
    }
    return new Date(year, month - 1, date + offset).toISOString();
}

export type AuditQuery = {
    q?: string;
    action?: string[];
    actor?: string[];
    since?: string;
    until?: string;
};

function listOf(value: string | undefined): string[] | undefined {
    const items = value ? value.split(",").filter(Boolean) : [];
    return items.length ? items : undefined;
}

export function auditQuery(search: AuditSearch): AuditQuery {
    return {
        q: search.q || undefined,
        action: listOf(search.action),
        actor: listOf(search.actor),
        since: search.from ? startOfDay(search.from) : undefined,
        until: search.to ? startOfDay(search.to, 1) : undefined,
    };
}

export function exportHref(query: AuditQuery, format: "csv" | "jsonl"): string {
    const params = new URLSearchParams({ format });
    for (const [key, value] of Object.entries(query)) {
        for (const item of Array.isArray(value) ? value : value ? [value] : []) {
            params.append(key, item);
        }
    }
    return `/api/audit/export?${params.toString()}`;
}
