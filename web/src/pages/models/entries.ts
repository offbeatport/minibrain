import type { ModelRow, ModelUsage, ModelVersionRow } from "~/api/client";
import type { Health } from "~/components/models/HealthStatus";
import { failingShare } from "~/components/models/ModelMetrics";

export type Entry = { key: string; model: ModelRow; version: ModelVersionRow | null };

export type EntryState = "error" | "live" | "progress" | "idle";

export const STATE_LABELS: Record<EntryState, string> = {
    error: "Errors",
    live: "Live",
    progress: "In progress",
    idle: "Not deployed",
};

export const STATE_RANK: EntryState[] = ["error", "live", "progress", "idle"];

const FAILING_SHARE = 0.01;

export function entriesOf(rows: ModelRow[]): Entry[] {
    return rows.flatMap((model): Entry[] => {
        const versions = model.kind === "custom" ? (model.versions ?? []) : [];
        if (versions.length === 0) {
            return [{ key: `${model.kind}:${model.key}`, model, version: null }];
        }
        return versions.map((version) => ({
            key: `${model.kind}:${model.key}@${version.number}`,
            model,
            version,
        }));
    });
}

export function usageOf(entry: Entry): ModelUsage | null | undefined {
    return entry.version ? entry.version.usage : entry.model.usage;
}

export function isLive(entry: Entry): boolean {
    if (entry.version) {
        return entry.version.live;
    }
    return entry.model.deployment.state !== "not_deployed";
}

export function failingEntry(entry: Entry): boolean {
    return isLive(entry) && failingShare(usageOf(entry)) >= FAILING_SHARE;
}

export function entryHealth(entry: Entry): Health | null {
    const { model, version } = entry;
    if (!version) {
        return model.health ?? null;
    }
    return version.health ?? (version.live ? (model.health ?? null) : null);
}

function modelError(model: ModelRow): boolean {
    return (
        Boolean(model.health) ||
        model.activity.state === "failed" ||
        model.availability.state === "missing" ||
        model.deployment.state === "unhealthy"
    );
}

export function stateOfEntry(entry: Entry): EntryState {
    const { model, version } = entry;
    if (failingEntry(entry)) {
        return "error";
    }
    if (version) {
        if (
            entryHealth(entry) ||
            version.status === "failed" ||
            (version.live && model.deployment.state === "unhealthy")
        ) {
            return "error";
        }
        if (version.live) {
            return "live";
        }
        return ["training", "evaluating"].includes(version.status) ? "progress" : "idle";
    }
    if (modelError(model)) {
        return "error";
    }
    if (model.deployment.state !== "not_deployed") {
        return "live";
    }
    const moving =
        ["running", "queued"].includes(model.activity.state) ||
        ["downloading", "importing"].includes(model.availability.state);
    return moving ? "progress" : "idle";
}

export const KIND_LABELS: Record<string, string> = {
    lora: "Trained",
    prompt: "Prompt-only",
};
