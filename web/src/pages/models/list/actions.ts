import { type ModelRow, api, removed, unwrap } from "~/api/client";
import { builtOn, deleteModel, rowId, setDeployed } from "~/lib/teardown";
import type { Entry } from "../entries";

export function promoteVersion(slug: string, number: number) {
    return unwrap(
        api.POST("/api/models/{slug}/versions/{number}/promote", {
            params: { path: { slug, number } },
        }),
    );
}

function deleteVersion(row: ModelRow, number: number, cancelJobs: boolean) {
    return removed(
        api.DELETE("/api/models/{slug}/versions/{number}", {
            params: { path: { slug: row.key, number }, query: { cancel_jobs: cancelJobs } },
        }),
    );
}

export function retryDownload(row: ModelRow) {
    return unwrap(api.POST("/api/base-models/{key}/retry", { params: { path: { key: row.key } } }));
}

export async function deployRows(rows: ModelRow[], deployed: boolean): Promise<void> {
    for (const row of rows) {
        await setDeployed(row, deployed);
    }
}

function unique(rows: ModelRow[]): ModelRow[] {
    return [...new Map(rows.map((row) => [rowId(row), row])).values()];
}

function cascading(whole: ModelRow[], rows: ModelRow[], cascade: boolean): Set<string> {
    const wholeKeys = new Set(whole.map(rowId));
    return new Set(
        whole
            .filter((row) => row.kind === "base")
            .filter((row) => {
                const built = builtOn(rows, row);
                return (
                    built.length > 0 &&
                    (cascade || built.every((item) => wholeKeys.has(rowId(item))))
                );
            })
            .map((row) => row.key),
    );
}

export async function deleteEntries(
    chosen: Entry[],
    rows: ModelRow[],
    cascade: boolean,
    cancelJobs: boolean,
): Promise<void> {
    const whole = unique(chosen.filter((entry) => !entry.version).map((entry) => entry.model));
    const wholeKeys = new Set(whole.map(rowId));
    const dropped = cascading(whole, rows, cascade);
    const versions = chosen.filter(
        (entry) =>
            entry.version &&
            !wholeKeys.has(rowId(entry.model)) &&
            !dropped.has(entry.model.base_model ?? ""),
    );
    for (const entry of versions) {
        await deleteVersion(entry.model, entry.version?.number ?? 0, cancelJobs);
    }
    for (const row of whole) {
        if (row.kind === "custom" && dropped.has(row.base_model ?? "")) {
            continue;
        }
        await deleteModel(row, { undeploy: true, cascade: dropped.has(row.key), cancelJobs });
    }
}
