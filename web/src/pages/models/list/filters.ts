import type { ModelsSearch } from "~/lib/modelsSearch";
import {
    type ListModel,
    attention,
    busyVersion,
    deployed,
    headlineOf,
    statusLine,
    updatedAt,
    usageOf,
} from "./model";

export type StatusKey = "deployed" | "off" | "attention" | "training" | "failed";
export type KindKey = "custom" | "base";
export type SortKey = "attention" | "name" | "score" | "requests" | "recent";
export type Filters = { status: StatusKey[]; kind: KindKey[]; base: string | null };
export type Column = "quality" | "requests" | "cost" | "p95";

export const NO_FILTERS: Filters = { status: [], kind: [], base: null };
export const DEFAULT_SORT: SortKey = "attention";

export const STATUSES: { value: StatusKey; label: string; test: (model: ListModel) => boolean }[] =
    [
        { value: "deployed", label: "Deployed", test: deployed },
        { value: "off", label: "Not deployed", test: (model) => !deployed(model) },
        { value: "attention", label: "Needs attention", test: attention },
        {
            value: "training",
            label: "Training",
            test: (model) => busyVersion(model) !== undefined,
        },
        { value: "failed", label: "Failed", test: (model) => statusLine(model).kind === "failed" },
    ];

export const KINDS: { value: KindKey; label: string }[] = [
    { value: "custom", label: "Custom" },
    { value: "base", label: "Base" },
];

export const SORTS: { value: SortKey; label: string; detail?: string }[] = [
    { value: "attention", label: "Needs attention first" },
    { value: "name", label: "Name", detail: "A to Z" },
    { value: "score", label: "Score", detail: "High to low" },
    { value: "requests", label: "Requests", detail: "Most first" },
    { value: "recent", label: "Recently updated", detail: "Newest first" },
];

export const COLUMNS: { id: Column; label: string; track: string }[] = [
    { id: "quality", label: "Quality", track: "minmax(10.5rem,auto)" },
    { id: "requests", label: "Requests, 7 days", track: "minmax(9rem,auto)" },
    { id: "cost", label: "Cost / 1k req.", track: "minmax(6rem,auto)" },
    { id: "p95", label: "p95", track: "minmax(4rem,auto)" },
];

export const DEFAULT_COLUMNS: Column[] = ["quality", "requests", "cost"];

export function gridTemplate(shown: Column[]): string {
    const tracks = COLUMNS.filter((column) => shown.includes(column.id)).map((c) => c.track);
    return ["minmax(14rem,1fr)", ...tracks, "minmax(10rem,14rem)", "auto"].join(" ");
}

function listOf<T extends string>(value: string | undefined, known: readonly T[]): T[] {
    const picked = (value ?? "").split(",");
    return known.filter((item) => picked.includes(item));
}

export function readFilters(search: ModelsSearch): Filters {
    return {
        status: listOf(
            search.state,
            STATUSES.map((item) => item.value),
        ),
        kind: listOf(
            search.kind,
            KINDS.map((item) => item.value),
        ),
        base: search.base || null,
    };
}

export function filterSearch(filters: Filters): ModelsSearch {
    return {
        state: filters.status.join(","),
        kind: filters.kind.join(","),
        base: filters.base ?? "",
    };
}

export function readSort(search: ModelsSearch): SortKey {
    return SORTS.find((item) => item.value === search.sort)?.value ?? DEFAULT_SORT;
}

export function activeCount(filters: Filters): number {
    return filters.status.length + filters.kind.length + (filters.base === null ? 0 : 1);
}

function statusPasses(model: ListModel, status: StatusKey[]): boolean {
    return (
        status.length === 0 ||
        STATUSES.some((option) => status.includes(option.value) && option.test(model))
    );
}

export function passes(model: ListModel, filters: Filters, skip?: keyof Filters): boolean {
    return (
        (skip === "status" || statusPasses(model, filters.status)) &&
        (skip === "kind" || filters.kind.length === 0 || filters.kind.includes(model.kind)) &&
        (skip === "base" || filters.base === null || model.baseGroup === filters.base)
    );
}

function scoreOf(model: ListModel): number {
    return headlineOf(model)?.score ?? -1;
}

function requestsOf(model: ListModel): number {
    return usageOf(model)?.total ?? 0;
}

const COMPARE: Record<SortKey, (a: ListModel, b: ListModel) => number> = {
    attention: (a, b) => Number(attention(b)) - Number(attention(a)),
    name: (a, b) => a.name.localeCompare(b.name),
    score: (a, b) => scoreOf(b) - scoreOf(a),
    requests: (a, b) => requestsOf(b) - requestsOf(a),
    recent: (a, b) => updatedAt(b).localeCompare(updatedAt(a)),
};

export function sortModels(models: ListModel[], sort: SortKey): ListModel[] {
    return [...models].sort(COMPARE[sort]);
}

export type BaseOption = { group: string; name: string; publisher: string | null };

export function baseOptions(models: ListModel[]): BaseOption[] {
    const found = new Map<string, BaseOption>();
    for (const model of models.filter((item) => item.kind === "base")) {
        found.set(model.key, {
            group: model.key,
            name: model.name,
            publisher: model.row.publisher ?? null,
        });
    }
    for (const model of models) {
        if (model.baseGroup && !found.has(model.baseGroup)) {
            found.set(model.baseGroup, {
                group: model.baseGroup,
                name: model.baseName ?? model.baseGroup,
                publisher: null,
            });
        }
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function toggled<T>(list: T[], value: T, on: boolean, order: T[]): T[] {
    return on
        ? order.filter((item) => item === value || list.includes(item))
        : list.filter((item) => item !== value);
}
