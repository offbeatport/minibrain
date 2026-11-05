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

export function setDeployed(row: ModelRow, deployed: boolean) {
    const body = { deployed };
    return row.kind === "base"
        ? unwrap(
              api.POST("/api/base-models/{key}/deploy", {
                  params: { path: { key: row.key } },
                  body,
              }),
          )
        : unwrap(
              api.POST("/api/models/{slug}/deploy", {
                  params: { path: { slug: row.key } },
                  body,
              }),
          );
}

export type DeleteOptions = { cascade?: boolean; undeploy?: boolean };

export function deleteModel(row: ModelRow, options: DeleteOptions = {}) {
    const undeploy = options.undeploy ?? false;
    return row.kind === "base"
        ? unwrap(
              api.DELETE("/api/base-models/{key}", {
                  params: {
                      path: { key: row.key },
                      query: { cascade: options.cascade ?? false, undeploy },
                  },
              }),
          )
        : unwrap(
              api.DELETE("/api/models/{slug}", {
                  params: { path: { slug: row.key }, query: { undeploy } },
              }),
          );
}

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
