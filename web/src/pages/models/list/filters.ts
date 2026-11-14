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
export type Column = "data" | "quality" | "requests" | "cost" | "p95";

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

export const COLUMNS: { id: Column; label: string; min: number; roomy?: number }[] = [
    { id: "data", label: "Data", min: 6 },
    { id: "quality", label: "Quality", min: 9.5 },
    { id: "requests", label: "Requests, 7 days", min: 7, roomy: 9.75 },
    { id: "cost", label: "Cost / 1k req.", min: 6 },
    { id: "p95", label: "p95", min: 4 },
];

export const DEFAULT_COLUMNS: Column[] = ["data", "quality", "requests", "cost"];

const MODEL_MIN = 10;
const STATUS_MIN = 8.5;
const STATUS_MAX = 14;
const MENU = 3;
const GAP = 0.75;
const PADDING = 2;
const DROP_FIRST: Column[] = ["p95", "cost", "data", "requests", "quality"];

export type TableLayout = { columns: Column[]; template: string };

function tracks(shown: Column[], roomy: boolean): number[] {
    return COLUMNS.filter((column) => shown.includes(column.id)).map((column) =>
        roomy ? (column.roomy ?? column.min) : column.min,
    );
}

function neededRem(shown: Column[], roomy: boolean): number {
    const columns = tracks(shown, roomy).reduce((sum, width) => sum + width, 0);
    return PADDING + MODEL_MIN + columns + STATUS_MIN + MENU + GAP * (shown.length + 2);
}

function layout(shown: Column[], roomy: boolean): TableLayout {
    const template = [
        `minmax(${MODEL_MIN}rem,1fr)`,
        ...tracks(shown, roomy).map((width) => `minmax(${width}rem,auto)`),
        `minmax(${STATUS_MIN}rem,${STATUS_MAX}rem)`,
        "auto",
    ].join(" ");
    return { columns: shown, template };
}

export function fitTable(shown: Column[], widthRem: number | null): TableLayout {
    if (widthRem === null || neededRem(shown, true) <= widthRem) {
        return layout(shown, true);
    }
    let fitted = shown;
    for (const id of DROP_FIRST) {
        if (neededRem(fitted, false) <= widthRem) {
            break;
        }
        fitted = fitted.filter((item) => item !== id);
    }
    return layout(fitted, false);
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
