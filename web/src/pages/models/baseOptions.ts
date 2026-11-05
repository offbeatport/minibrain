import type { CatalogEntry, CatalogVariantInfo, FitInfo, ModelRow } from "~/api/client";
import { parameters } from "./Discover";
import { FIT_ORDER, type LicenceUse } from "./DiscoverFilters";
import { trainable } from "./formats";
import { runnable } from "./runsHere";

export type TaskKey = "classify" | "extract" | "rewrite" | "sql" | "distill" | "answer";

export type FitLevel = FitInfo["level"];

type AddedInfo = CatalogEntry["added"][number];

export type BaseOption = {
    key: string;
    kind: "catalogue" | "local" | "custom";
    name: string;
    publisher: string | null;
    params: string | null;
    entry: CatalogEntry | null;
    variant: CatalogVariantInfo | null;
    added: AddedInfo | null;
    baseKey: string | null;
    size: number | null;
    fit: FitLevel;
    licence: LicenceUse | null;
    custom: ModelRow | null;
    note: string | null;
};

type TaskNeeds = {
    capability: string;
    tiers: Record<string, number>;
    prefer?: string;
    avoid?: string[];
};

const TASK_NEEDS: Record<TaskKey, TaskNeeds> = {
    classify: {
        capability: "Classification",
        tiers: { S: 3, M: 2, L: 1, XL: 0 },
        avoid: ["Reasoning", "Code"],
    },
    extract: {
        capability: "Extraction",
        tiers: { S: 2, M: 3, L: 2, XL: 1 },
        avoid: ["Reasoning"],
    },
    rewrite: { capability: "Chat", tiers: { S: 1, M: 3, L: 2, XL: 1 }, avoid: ["Code"] },
    sql: { capability: "Chat", tiers: { S: 1, M: 3, L: 2, XL: 1 }, prefer: "Code" },
    distill: { capability: "Chat", tiers: { S: 3, M: 2, L: 1, XL: 0 }, avoid: ["Reasoning"] },
    answer: { capability: "Chat", tiers: { S: 1, M: 3, L: 3, XL: 2 } },
};

const RUNS_HERE = 3;
const NEEDS_MORE = 2;
const RECENT = 3;

function taskScore(entry: CatalogEntry, task: TaskKey): number | null {
    const needs = TASK_NEEDS[task];
    if (!entry.capabilities.includes(needs.capability)) {
        return null;
    }
    const preferred = needs.prefer && entry.capabilities.includes(needs.prefer) ? 1 : 0;
    const avoided = needs.avoid?.some((item) => entry.capabilities.includes(item)) ? 2 : 0;
    return (needs.tiers[entry.tier] ?? 0) + (entry.recommended ? 2 : 0) + preferred - avoided;
}

function byFit(variants: CatalogVariantInfo[]): CatalogVariantInfo | undefined {
    return [...variants].sort(
        (a, b) => FIT_ORDER.indexOf(a.fit.level) - FIT_ORDER.indexOf(b.fit.level),
    )[0];
}

export function trainableVariant(entry: CatalogEntry): CatalogVariantInfo | undefined {
    return byFit(entry.variants.filter(trainable));
}

const GONE = new Set(["not_downloaded", "evicted"]);

function present(added: AddedInfo): boolean {
    return !GONE.has(added.availability.state);
}

function variantOf(
    entry: CatalogEntry,
    id: string | null | undefined,
): CatalogVariantInfo | undefined {
    return entry.variants.find((variant) => variant.id === id);
}

function installedTrainable(entry: CatalogEntry): AddedInfo | undefined {
    const copies = entry.added.filter((added) => {
        const variant = variantOf(entry, added.variant_id);
        return present(added) && (!variant || trainable(variant));
    });
    return copies.find((added) => added.availability.state === "available") ?? copies[0];
}

function preferredVariant(entry: CatalogEntry): CatalogVariantInfo {
    const installed = installedTrainable(entry);
    return (
        variantOf(entry, installed?.variant_id) ??
        trainableVariant(entry) ??
        byFit(entry.variants) ??
        entry.variants[0]
    );
}

function addedFor(entry: CatalogEntry, variant: CatalogVariantInfo, chosen: boolean) {
    const copies = entry.added.filter(present);
    return (
        copies.find((added) => added.variant_id === variant.id) ??
        (chosen ? undefined : copies.find((added) => !variantOf(entry, added.variant_id)))
    );
}

export function servesOnly(option: BaseOption | null): boolean {
    return Boolean(option?.variant && !trainable(option.variant));
}

export function catalogueOption(entry: CatalogEntry, variantId?: string): BaseOption {
    const picked = variantOf(entry, variantId);
    const variant = picked ?? preferredVariant(entry);
    const added = addedFor(entry, variant, Boolean(picked)) ?? null;
    return {
        key: `entry:${entry.id}:${variant.id}`,
        kind: "catalogue",
        name: entry.name,
        publisher: entry.provider,
        params: parameters(entry),
        entry,
        variant,
        added,
        baseKey: added?.key ?? null,
        size: variant.size_bytes,
        fit: variant.fit.level,
        licence: entry.license_use,
        custom: null,
        note: entry.superseded_by ? "A newer version is in the catalogue" : null,
    };
}

function localOption(row: ModelRow): BaseOption {
    return {
        key: `local:${row.key}`,
        kind: "local",
        name: row.name,
        publisher: row.publisher ?? null,
        params: null,
        entry: null,
        variant: null,
        added: {
            key: row.key,
            variant_id: null,
            availability: row.availability,
            error: row.error ?? null,
        },
        baseKey: row.key,
        size: row.size_bytes ?? null,
        fit: "unknown",
        licence: null,
        custom: null,
        note: "Imported on this install",
    };
}

export function baseOptionFor(
    key: string,
    entries: CatalogEntry[],
    rows: ModelRow[],
): BaseOption | null {
    const linked = entries.find((entry) => entry.added.some((added) => added.key === key));
    if (linked) {
        const variantId = linked.added.find((added) => added.key === key)?.variant_id;
        return catalogueOption(linked, variantId ?? undefined);
    }
    const listed = entries.find((entry) => entry.id === key);
    if (listed) {
        return catalogueOption(listed);
    }
    const row = rows.find((item) => item.kind === "base" && item.key === key);
    return row ? localOption(row) : null;
}

export function servingCopies(entry: CatalogEntry): BaseOption[] {
    const main = preferredVariant(entry);
    return entry.added
        .filter((added) => present(added) && added.variant_id !== main.id)
        .map((added) => variantOf(entry, added.variant_id))
        .filter((variant): variant is CatalogVariantInfo => Boolean(variant && !trainable(variant)))
        .map((variant) => catalogueOption(entry, variant.id));
}

export function localBases(entries: CatalogEntry[], rows: ModelRow[]): BaseOption[] {
    const linked = new Set(entries.flatMap((entry) => entry.added.map((added) => added.key)));
    return rows
        .filter(
            (row) =>
                row.kind === "base" && !linked.has(row.key) && !GONE.has(row.availability.state),
        )
        .map(localOption);
}

export function customOptions(entries: CatalogEntry[], rows: ModelRow[]): BaseOption[] {
    return rows
        .filter((row) => row.kind === "custom" && row.base_model)
        .map((row) => {
            const base = baseOptionFor(row.base_model ?? "", entries, rows);
            const version = row.current_version ?? row.ready_version;
            return {
                key: `custom:${row.key}`,
                kind: "custom",
                name: row.name,
                publisher: base?.publisher ?? null,
                params: base?.params ?? null,
                entry: base?.entry ?? null,
                variant: base?.variant ?? null,
                added: base?.added ?? null,
                baseKey: base?.baseKey ?? row.base_model,
                size: base?.size ?? null,
                fit: base?.fit ?? "unknown",
                licence: base?.licence ?? null,
                custom: row,
                note: [
                    `Based on ${base?.name ?? row.base_model}`,
                    version !== null && version !== undefined ? `version ${version}` : null,
                ]
                    .filter(Boolean)
                    .join(", "),
            };
        });
}

function ranked(entries: CatalogEntry[], task: TaskKey): CatalogEntry[] {
    return entries
        .map((entry) => ({ entry, score: entry.superseded_by ? null : taskScore(entry, task) }))
        .filter((item): item is { entry: CatalogEntry; score: number } => item.score !== null)
        .sort((a, b) => b.score - a.score || b.entry.popularity - a.entry.popularity)
        .map((item) => item.entry);
}

export type Recommendations = {
    recent: BaseOption[];
    here: BaseOption[];
    more: BaseOption[];
    unchecked: BaseOption[];
};

export function recommend(
    entries: CatalogEntry[],
    rows: ModelRow[],
    task: TaskKey,
): Recommendations {
    const options = ranked(entries, task).map((entry) => {
        const option = catalogueOption(entry);
        return { ...option, note: entry.recommendation ?? null };
    });
    const here = options.filter((option) => runnable(option.fit)).slice(0, RUNS_HERE);
    const more = options.filter((option) => option.fit === "insufficient").slice(0, NEEDS_MORE);
    const unchecked =
        here.length + more.length === 0 ? options.slice(0, RUNS_HERE + NEEDS_MORE) : [];
    const usedKeys = rows
        .filter((row) => row.kind === "custom" && row.base_model)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .map((row) => row.base_model ?? "");
    const recent = [...new Set(usedKeys)]
        .map((key) => baseOptionFor(key, entries, rows))
        .filter((option): option is BaseOption => option !== null)
        .filter((option, index, all) => all.findIndex((item) => item.key === option.key) === index)
        .slice(0, RECENT);
    return { recent, here, more, unchecked };
}

export function logoPublisher(option: BaseOption | null): string | null {
    return option && option.kind !== "custom" ? option.publisher : null;
}

export function searchText(option: BaseOption): string {
    return [
        option.name,
        option.publisher,
        option.entry?.repo,
        option.entry?.id,
        option.entry?.family,
        option.baseKey,
        option.custom?.key,
        option.note,
    ]
        .filter(Boolean)
        .join(" ");
}

export function gigabytes(value: number): string {
    const gib = value / 1024 ** 3;
    return gib >= 10 ? gib.toFixed(0) : gib.toFixed(1);
}

export function addedKey(entry: CatalogEntry, variant: CatalogVariantInfo): string {
    return entry.variants[0]?.id === variant.id ? entry.id : variant.id.replaceAll(":", "-");
}
