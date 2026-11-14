import type { ToastOptions } from "obp-ui";
import { type ModelRow, api, unwrap } from "~/api/client";
import type { components } from "~/api/schema";

export type Teardown = components["schemas"]["TeardownInfo"];

export function rowId(row: ModelRow): string {
    return `${row.kind}:${row.key}`;
}

export function busyTearingDown(row: ModelRow): boolean {
    return row.teardown?.state === "running";
}

export function beingDeleted(row: ModelRow): boolean {
    return row.teardown?.kind === "delete" && row.teardown.state === "running";
}

export function builtOn(rows: ModelRow[], base: ModelRow): ModelRow[] {
    return rows
        .filter((row) => row.kind === "custom" && row.base_model === base.key)
        .sort((left, right) => left.name.localeCompare(right.name));
}

export function isLiveRow(row: ModelRow): boolean {
    return row.deployment.state !== "not_deployed";
}

export function setDeployed(row: ModelRow, deployed: boolean, pool?: string, replicas?: number) {
    const body = { deployed, pool, replicas };
    return unwrap(
        api.POST("/api/models/{name}/deploy", { params: { path: { name: row.key } }, body }),
    );
}

export type DeleteOptions = { cascade?: boolean; undeploy?: boolean; cancelJobs?: boolean };

export function deleteModel(row: ModelRow, options: DeleteOptions = {}) {
    const undeploy = options.undeploy ?? false;
    const cancel_jobs = options.cancelJobs ?? false;
    const cascade = row.kind === "base" && (options.cascade ?? false);
    return unwrap(
        api.DELETE("/api/models/{name}", {
            params: { path: { name: row.key }, query: { cascade, undeploy, cancel_jobs } },
        }),
    );
}

export function needsReview(teardown: Teardown | null | undefined): boolean {
    return (
        teardown?.state === "failed" &&
        ((teardown.added?.length ?? 0) > 0 || (teardown.jobs?.length ?? 0) > 0)
    );
}

export const REVIEW_LABEL = "Delete again…";

export function retryTeardown(row: ModelRow): Promise<unknown> {
    const teardown = row.teardown;
    if (!teardown) {
        return Promise.resolve();
    }
    if (teardown.kind === "undeploy") {
        return setDeployed(row, false);
    }
    return deleteModel(row, { cascade: teardown.cascade, undeploy: teardown.undeploy });
}

export const RETRY_LABELS: Record<Teardown["kind"], string> = {
    delete: "Retry delete",
    undeploy: "Retry undeploy",
};

function models(count: number): string {
    return count === 1 ? "1 model" : `${count} models`;
}

function deleted(teardown: Teardown, name: string): ToastOptions {
    const others = teardown.models?.length ?? 0;
    return {
        title: others ? `Deleted ${name} and ${models(others)} built on it` : `Deleted ${name}`,
        tone: "success",
    };
}

const FAILED_TITLES: Record<Teardown["kind"], (name: string) => string> = {
    delete: (name) => `Couldn't delete ${name}`,
    undeploy: (name) => `Couldn't stop ${name}`,
};

export function outcomeOf(before: ModelRow, after: ModelRow | undefined): ToastOptions | null {
    const teardown = before.teardown;
    if (!teardown || teardown.state !== "running" || teardown.part_of) {
        return null;
    }
    if (after?.teardown?.state === "failed") {
        return {
            title: FAILED_TITLES[teardown.kind](before.name),
            description: after.teardown.error ?? after.teardown.detail,
            tone: "destructive",
            timeout: 10000,
        };
    }
    if (teardown.kind === "delete") {
        return after ? null : deleted(teardown, before.name);
    }
    if (!after || after.teardown) {
        return null;
    }
    return {
        title: `Undeployed ${before.name}`,
        description: "No gateway routes it and its engines have unloaded it.",
        tone: "success",
    };
}
