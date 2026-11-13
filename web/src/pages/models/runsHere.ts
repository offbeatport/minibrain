import { useQueries } from "@tanstack/react-query";
import {
    type CatalogEntry,
    type CatalogResponse,
    type CatalogVariantInfo,
    type FitInfo,
    api,
    unwrap,
} from "~/api/client";
import { keys } from "~/api/queries";

export const RUNS_HERE_INFO =
    "Fits in memory on a machine in one of your compute pools, on demand ones included.";

export const TRAINS_HERE_INFO =
    "A machine that runs training jobs in one of your compute pools has the memory to train it.";

export const TRAIN_MEMORY_INFO =
    "Memory to train with QLoRA 4-bit and gradient checkpointing on an NVIDIA GPU, one 512-token row at a time.";

export type RunsHere = (entry: CatalogEntry | null | undefined) => boolean;

export function runnable(level: FitInfo["level"]): boolean {
    return level === "fits" || level === "limited";
}

function runsAnywhere(entry: CatalogEntry): boolean {
    return entry.variants.some((variant) => runnable(variant.fit.level));
}

function trainsAnywhere(entry: CatalogEntry): boolean {
    return entry.variants.some((variant) => variant.train_fit.level === "fits");
}

export function trainMemory(variant: CatalogVariantInfo | null | undefined): number | null {
    return variant?.train_fit.qlora_bytes ?? null;
}

export function leastTrainMemory(entry: CatalogEntry): number | null {
    const found = entry.variants
        .map(trainMemory)
        .filter((value): value is number => value !== null);
    return found.length > 0 ? Math.min(...found) : null;
}

function usePoolEntries(catalog: CatalogResponse | undefined): CatalogEntry[] {
    const others = (catalog?.pools ?? []).filter((pool) => pool.name !== catalog?.pool);
    const lists = useQueries({
        queries: others.map((pool) => ({
            queryKey: [...keys.catalog, pool.name],
            queryFn: () =>
                unwrap(api.GET("/api/catalog", { params: { query: { pool: pool.name } } })),
        })),
        combine: (results) => results.flatMap((result) => result.data?.entries ?? []),
    });
    return [...(catalog?.entries ?? []), ...lists];
}

function matching(entries: CatalogEntry[], test: (entry: CatalogEntry) => boolean): RunsHere {
    const ids = new Set(entries.filter(test).map((entry) => entry.id));
    return (entry) => Boolean(entry && ids.has(entry.id));
}

export function useRunsHere(catalog: CatalogResponse | undefined): RunsHere {
    return matching(usePoolEntries(catalog), runsAnywhere);
}

export function useTrainsHere(catalog: CatalogResponse | undefined): RunsHere {
    return matching(usePoolEntries(catalog), trainsAnywhere);
}

export type PoolFits = { serve: string[]; train: string[]; checked: boolean };

export function usePoolFits(
    catalog: CatalogResponse | undefined,
    entryId: string | null | undefined,
    variantId: string | null | undefined,
): PoolFits {
    const others = (catalog?.pools ?? []).filter((pool) => pool.name !== catalog?.pool);
    const lists = useQueries({
        queries: others.map((pool) => ({
            queryKey: [...keys.catalog, pool.name],
            queryFn: () =>
                unwrap(api.GET("/api/catalog", { params: { query: { pool: pool.name } } })),
            enabled: Boolean(entryId),
        })),
        combine: (results) => results.map((result) => result.data?.entries ?? null),
    });
    const all = [
        { name: catalog?.pool ?? "", entries: catalog?.entries ?? null },
        ...others.map((pool, index) => ({ name: pool.name, entries: lists[index] ?? null })),
    ];
    const variants = all.map((pool) => ({
        name: pool.name,
        variant: pool.entries
            ?.find((entry) => entry.id === entryId)
            ?.variants.find((variant) => variant.id === variantId),
        checked: pool.entries !== null,
    }));
    return {
        serve: variants
            .filter((item) => item.variant && runnable(item.variant.fit.level))
            .map((item) => item.name),
        train: variants
            .filter((item) => item.variant?.train_fit.level === "fits")
            .map((item) => item.name),
        checked: variants.every((item) => item.checked),
    };
}
