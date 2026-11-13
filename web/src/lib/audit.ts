import type { components } from "~/api/schema";
import { AVATAR_STYLES } from "~/components/avatar/avatarStyles";
import { TONE_LABELS, type ToneName } from "~/components/avatar/tones";
import { listHref } from "~/lib/listSearch";
import { API_KEYS_PATH, jobHref, modelPageHref, modelVersionHref } from "~/lib/modelLinks";
import { bytes, exactTime } from "~/lib/time";

export type AuditEvent = components["schemas"]["AuditInfo"];
export type AuditTarget = components["schemas"]["AuditTarget"];
type PolicyInfo = components["schemas"]["PolicyInfo"];
type Detail = Record<string, unknown>;

export const AUDIT_PATH = "/settings/audit";
export const AUDIT_KEYS = [
    "q",
    "category",
    "action",
    "actor",
    "target",
    "range",
    "from",
    "to",
    "before",
    "after",
    "event",
] as const;
export type AuditSearch = Partial<Record<(typeof AUDIT_KEYS)[number], string>>;

const ACTIONS: Record<string, string> = {
    "connection.create": "Connection created",
    "connection.delete": "Connection deleted",
    "connection.update": "Connection changed",
    "encryption.key": "Encryption key added",
    "encryption.retire": "Encryption key retired",
    "encryption.rotate": "Encryption key rotated",
    "feedback.example": "Feedback added to test examples",
    "feedback.example_remove": "Test example removed",
    "job.delete": "Job deleted",
    "model.contract": "Output format changed",
    "model.create": "Model created",
    "model.graders": "Graders changed",
    "model.instructions": "Instructions changed",
    "model.judge": "Judge changed",
    "model.labels_dismiss": "Label suggestions dismissed",
    "model.name_release": "API name released",
    "model.promotion": "Promotion rule changed",
    "model.rescore": "Versions re-scored",
    "model.update": "Model changed",
    "settings.judge": "Default judge changed",
    "settings.prices": "Compute prices changed",
    "account.create": "Account created",
    "account.password": "Password set",
    "account.reset": "Password link created",
    "account.update": "Account changed",
    "audit.prune": "Audit events deleted",
    "auth.setup_link": "Setup link created",
    "auth.sign_in": "Signed in",
    "auth.sign_in_failed": "Sign-in refused",
    "auth.sign_out": "Signed out",
    "feedback.accept": "Feedback accepted",
    "feedback.assign": "Feedback assigned",
    "feedback.fix": "Feedback fixed and accepted",
    "feedback.reject": "Feedback rejected",
    "feedback.unassign": "Feedback unassigned",
    "dataset.delete": "Dataset deleted",
    "dataset.move": "Dataset moved",
    "dataset_folder.create": "Dataset folder created",
    "dataset_folder.delete": "Dataset folder deleted",
    "dataset_folder.move": "Dataset folder moved",
    "dataset_folder.rename": "Dataset folder renamed",
    "job.cancel": "Job cancelled",
    "job.retry": "Job retried",
    "key.create": "API key created",
    "key.revoke": "API key revoked",
    "key.update": "API key changed",
    "model.delete": "Model delete started",
    "model.delete_finished": "Model delete finished",
    "model.deploy": "Model deployed",
    "model.avatar": "Avatar changed",
    "model.base_change": "Model base switched",
    "model.duplicate": "Model duplicated",
    "model.reimport": "Model re-imported",
    "model.request_bodies": "Request inputs and answers changed",
    "model.safety": "Safety model changed",
    "model.relocate": "Model moved",
    "model.repair": "Model repaired",
    "model.undeploy": "Model undeploy started",
    "model.undeploy_finished": "Model undeploy finished",
    "model.verify": "Model files checked",
    "policy.update": "Policy changed",
    "safety.block": "Blocked by the safety model",
    "settings.safety": "Safety model setting changed",
    "storage.update": "Storage changed",
    "version.card": "Model card edited",
    "version.create": "Version created",
    "version.delete": "Version deleted",
    "version.delete_finished": "Version delete finished",
    "version.promote": "Version deployed",
};

const KEY_LABELS: Record<string, string> = {
    adapters: "Adapters",
    artifacts: "Stored files",
    attempt: "Attempt",
    budget_bytes: "Budget",
    cascade: "Models deleted with it",
    cut_hash: "Hash at the cut",
    cut_seq: "Cut at seq",
    days: "Retention",
    deleted: "Events deleted",
    disabled: "Turned off",
    files: "Files",
    first_admin: "First admin",
    from: "Before",
    intended_use: "Intended use",
    job: "Job",
    key_scopes: "API key scopes",
    kept: "Files kept at",
    kind: "Kind",
    known_limits: "Known limits",
    last_used_at: "Last used",
    link_expires_at: "Link expires",
    models: "Models",
    name: "Name",
    older_than: "Older than",
    outcome: "Outcome",
    removed: "Removed",
    retry: "Attempt",
    role: "Role",
    routes: "Model names",
    seconds: "Seconds",
    sign_in: "Signed in with",
    size_bytes: "Size",
    source: "Source",
    status: "Status",
    stopped: "Stopped",
    to: "After",
    trigger: "Trigger",
    undeploy: "Undeployed first",
    versions: "Versions",
    with_base: "Deleted with base",
};

const CHANGED_FIELDS: Record<string, string> = {
    "dataset.move": "Location",
    "dataset_folder.move": "Location",
    "dataset_folder.rename": "Name",
    "model.relocate": "Location",
};

const STORAGE_KINDS: Record<string, string> = { local: "Local folder", s3: "S3-compatible bucket" };
const SIGN_INS: Record<string, string> = {
    local: "Password",
    oidc: "Single sign-on",
    proxy: "Proxy",
};
const ROLES: Record<string, string> = { viewer: "Viewer", builder: "Builder", admin: "Admin" };
const NAMED_VALUES: Record<string, Record<string, string>> = { sign_in: SIGN_INS, role: ROLES };
const VERSION_KINDS: Record<string, string> = { lora: "LoRA version", prompt: "Prompt version" };

const CATEGORIES: Record<string, string> = {
    account: "Accounts",
    audit: "Audit log",
    auth: "Sign-in",
    connection: "Connections",
    dataset: "Datasets",
    dataset_folder: "Dataset folders",
    encryption: "Encryption",
    feedback: "Feedback",
    job: "Jobs",
    key: "API keys",
    model: "Models",
    policy: "Policies",
    safety: "Safety",
    settings: "Settings",
    storage: "Storage",
    version: "Versions",
};

function sentence(text: string): string {
    const words = text.replaceAll(/[._]+/g, " ").trim();
    return words ? words[0].toUpperCase() + words.slice(1) : text;
}

export function actionLabel(action: string): string {
    return ACTIONS[action] ?? sentence(action);
}

export function categoryOf(action: string): string {
    return action.split(".")[0];
}

export function categoryLabel(category: string): string {
    return CATEGORIES[category] ?? sentence(category);
}

export function actorLabel(actor: string, name?: string | null): string {
    if (name) {
        return name;
    }
    if (actor === "system") {
        return "System";
    }
    if (actor === "command line") {
        return "Command line";
    }
    if (actor.startsWith("api_key:")) {
        return `API key #${actor.slice("api_key:".length)}`;
    }
    return actor;
}

export function actorOf(event: AuditEvent): string {
    return actorLabel(event.actor, event.actor_name);
}

export type Result = { label: string; failed: boolean };

const OK: Result = { label: "OK", failed: false };

export function resultOf(event: AuditEvent): Result {
    const detail = event.detail as Detail;
    if (event.action === "safety.block") {
        return { label: "Blocked", failed: true };
    }
    if (event.action.endsWith("_failed")) {
        return { label: "Refused", failed: true };
    }
    if (detail.outcome === "failed") {
        return { label: "Failed", failed: true };
    }
    return OK;
}

export function utcTime(value: string): string {
    return `${new Date(value).toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

function jobKind(event: AuditEvent): string {
    const kind = (event.detail as Detail).kind;
    return typeof kind === "string" ? kind : "";
}

export function targetHref(event: AuditEvent): string | undefined {
    const ref = event.target_ref;
    if (!ref?.live) {
        return undefined;
    }
    const [slug, number] = ref.key.split("@");
    const links: Record<AuditTarget["kind"], () => string> = {
        model: () => modelPageHref(ref.key),
        version: () => modelVersionHref(slug, Number(number)),
        key: () => listHref(API_KEYS_PATH, { q: ref.key }),
        account: () => "/settings/accounts",
        job: () => jobHref({ id: Number(ref.key), kind: jobKind(event) }),
        dataset: () => `/data?item=${encodeURIComponent(`dataset:${ref.key}`)}`,
        dataset_folder: () => "/data",
        feedback: () => listHref("/feedback", { item: ref.key.split("/").at(-1) }),
        connection: () => "/settings/connections",
        policy: () => "/settings/security",
    };
    return links[ref.kind]();
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
        if (key.endsWith("_port")) {
            return String(value);
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
    if (NAMED_VALUES[key]?.[text]) {
        return NAMED_VALUES[key][text];
    }
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
    const name = typeof detail.name === "string" && detail.name ? detail.name : event.target;
    const version = event.action.startsWith("version.") ? event.target.split("@")[1] : undefined;
    return version && name !== event.target ? `${name} v${version}` : name;
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
    const field = policy?.label ?? CHANGED_FIELDS[event.action] ?? "Value";
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

function avatarText(value: unknown): string {
    if (!value || typeof value !== "object") {
        return "Avatar";
    }
    const avatar = value as Detail;
    const style = AVATAR_STYLES.find((item) => item.id === avatar.style)?.name ?? "Avatar";
    const tone = TONE_LABELS[avatar.tone as ToneName] ?? "";
    const letters = typeof avatar.letters === "string" ? ` ${avatar.letters}` : "";
    return tone ? `${style}${letters} · ${tone}` : `${style}${letters}`;
}

const SUMMARIES: Record<string, (detail: Detail) => string> = {
    "account.create": (detail) => `Role ${plainValue(detail.role, undefined, "role")}`,
    "account.password": (detail) =>
        detail.via === "command line" ? "On the command line" : "With a one-time link",
    "account.reset": (detail) =>
        `Link expires ${plainValue(detail.link_expires_at, undefined, "link_expires_at")}`,
    "auth.setup_link": () => "For the first admin; earlier links stop working",
    "auth.sign_in": (detail) => `With ${plainValue(detail.sign_in, undefined, "sign_in")}`,
    "auth.sign_in_failed": (detail) => plainValue(detail.reason),
    "auth.sign_out": () => "Session ended",
    "audit.prune": (detail) =>
        `${plainValue(detail.deleted)} events older than ${plainValue(detail.days, undefined, "days")}${
            typeof detail.cut_seq === "number" ? `, up to seq ${plainValue(detail.cut_seq)}` : ""
        }`,
    "feedback.accept": (detail) => `Right answer: ${plainValue(detail.label)}`,
    "feedback.fix": (detail) => `Fixed to ${plainValue(detail.label)}`,
    "feedback.reject": () => "Kept out of the training data",
    "job.cancel": (detail) =>
        detail.status === "running" ? "Stop requested while running" : "Taken off the queue",
    "job.retry": (detail) =>
        typeof detail.job === "number" ? `Queued again as job #${detail.job}` : "Queued again",
    "model.delete": (detail) =>
        typeof detail.size_bytes === "number" ? `Freed ${bytes(detail.size_bytes)}` : "Deleted",
    "model.avatar": (detail) => avatarText(detail.to),
    "model.base_change": (detail) => `${plainValue(detail.from)} → ${plainValue(detail.to)}`,
    "model.duplicate": (detail) =>
        typeof detail.version === "number"
            ? `From ${plainValue(detail.source)} v${detail.version}`
            : `From ${plainValue(detail.source)}`,
    "model.reimport": (detail) => `From ${plainValue(detail.source)}`,
    "model.relocate": (detail) => `${plainValue(detail.from)} → ${plainValue(detail.to)}`,
    "model.repair": (detail) => `From ${plainValue(detail.source)}`,
    "model.verify": (detail) => `${plainValue(detail.files)} files`,
    "version.create": (detail) => VERSION_KINDS[String(detail.kind)] ?? "Version",
    "version.delete": (detail) => VERSION_KINDS[String(detail.kind)] ?? "Version",
    "version.promote": (detail) =>
        typeof detail.previous === "number" && detail.was_deployed
            ? `Replaced v${detail.previous}`
            : "Put live",
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
        .filter(([name]) => name !== "name" && name !== "sign_in")
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
    category?: string[];
    action?: string[];
    actor?: string[];
    target?: string[];
    since?: string;
    until?: string;
};

export const CUSTOM_RANGE = "custom";
const HOUR_MS = 3600 * 1000;
export const RANGES: [string, string, number][] = [
    ["1h", "Last hour", HOUR_MS],
    ["24h", "Last 24 hours", 24 * HOUR_MS],
    ["7d", "Last 7 days", 7 * 24 * HOUR_MS],
    ["30d", "Last 30 days", 30 * 24 * HOUR_MS],
    ["90d", "Last 90 days", 90 * 24 * HOUR_MS],
];

function rangeSince(range: string | undefined): string | undefined {
    const span = RANGES.find(([value]) => value === range)?.[2];
    return span === undefined ? undefined : new Date(Date.now() - span).toISOString();
}

function listOf(value: string | undefined): string[] | undefined {
    const items = value ? value.split(",").filter(Boolean) : [];
    return items.length ? items : undefined;
}

export function auditQuery(search: AuditSearch): AuditQuery {
    const custom = search.range === CUSTOM_RANGE;
    return {
        q: search.q || undefined,
        category: listOf(search.category),
        action: listOf(search.action),
        actor: listOf(search.actor),
        target: listOf(search.target),
        since: custom
            ? search.from
                ? startOfDay(search.from)
                : undefined
            : rangeSince(search.range),
        until: custom && search.to ? startOfDay(search.to, 1) : undefined,
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
