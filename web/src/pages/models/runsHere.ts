import { useQueries } from "@tanstack/react-query";
import { type CatalogEntry, type CatalogResponse, type FitInfo, api, unwrap } from "~/api/client";
import { keys } from "~/api/queries";

export const RUNS_HERE_INFO =
    "Fits in memory on a machine in one of your compute pools, on demand ones included.";

export type RunsHere = (entry: CatalogEntry | null | undefined) => boolean;

export function runnable(level: FitInfo["level"]): boolean {
    return level === "fits" || level === "limited";
}

function runsAnywhere(entry: CatalogEntry): boolean {
    return entry.variants.some((variant) => runnable(variant.fit.level));
}

export function useRunsHere(catalog: CatalogResponse | undefined): RunsHere {
    const others = (catalog?.pools ?? []).filter((pool) => pool.name !== catalog?.pool);
    const lists = useQueries({
        queries: others.map((pool) => ({
            queryKey: [...keys.catalog, pool.name],
            queryFn: () =>
                unwrap(api.GET("/api/catalog", { params: { query: { pool: pool.name } } })),
        })),
        combine: (results) => results.flatMap((result) => result.data?.entries ?? []),
    });
    const ids = new Set(
        [...(catalog?.entries ?? []), ...lists].filter(runsAnywhere).map((entry) => entry.id),
    );
    return (entry) => Boolean(entry && ids.has(entry.id));
}
