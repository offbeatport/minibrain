import { useRouter, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo } from "react";

const KEYS = [
    "q",
    "type",
    "availability",
    "deployment",
    "attention",
    "state",
    "task",
    "provider",
    "fits",
    "access",
    "tier",
    "pool",
    "bases",
    "fit",
    "support",
    "licence",
    "latest",
    "sort",
] as const;

export type ModelsSearchKey = (typeof KEYS)[number];
export type ModelsSearch = Partial<Record<ModelsSearchKey, string>>;

export type ModelsPath = "/models" | "/discover";

const PAGE_KEYS: Record<ModelsPath, readonly ModelsSearchKey[]> = {
    "/models": ["q", "state", "bases"],
    "/discover": [
        "q",
        "task",
        "provider",
        "fits",
        "fit",
        "access",
        "tier",
        "pool",
        "support",
        "licence",
        "latest",
        "sort",
    ],
};

function storageKey(path: ModelsPath): string {
    return `minibrain${path.replace("/", ".")}.search`;
}

export function readModelsSearch(search: unknown, path?: ModelsPath): ModelsSearch {
    const source = (search ?? {}) as Record<string, unknown>;
    const found: ModelsSearch = {};
    for (const key of path ? PAGE_KEYS[path] : KEYS) {
        const value = source[key];
        if (value !== undefined && value !== null && String(value) !== "") {
            found[key] = String(value);
        }
    }
    return found;
}

export function searchString(search: ModelsSearch): string {
    const params = new URLSearchParams();
    for (const key of KEYS) {
        const value = search[key];
        if (value) {
            params.set(key, value);
        }
    }
    const text = params.toString();
    return text ? `?${text}` : "";
}

function remember(path: ModelsPath, search: ModelsSearch): void {
    try {
        window.sessionStorage.setItem(storageKey(path), searchString(search));
    } catch {
        return;
    }
}

export function modelsHref(): string {
    return `/models${remembered("/models")}`;
}

export function discoverListHref(): string {
    return `/discover${remembered("/discover")}`;
}

function remembered(path: ModelsPath): string {
    try {
        const stored = window.sessionStorage.getItem(storageKey(path)) ?? "";
        return searchString(
            readModelsSearch(Object.fromEntries(new URLSearchParams(stored)), path),
        );
    } catch {
        return "";
    }
}

export function useModelsSearch(path: ModelsPath) {
    const router = useRouter();
    const raw = useRouterState({
        select: (state) => searchString(readModelsSearch(state.location.search, path)),
    });
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    useEffect(() => {
        const saved = remembered(path);
        if (pathname === path && !raw && saved) {
            router.history.replace(`${path}${saved}`);
        }
    }, [pathname, raw, router, path]);
    const search = useMemo(
        () => readModelsSearch(Object.fromEntries(new URLSearchParams(raw)), path),
        [raw, path],
    );
    const update = useCallback(
        (patch: ModelsSearch) => {
            const next = readModelsSearch({ ...search, ...patch }, path);
            remember(path, next);
            router.history.replace(`${path}${searchString(next)}`);
        },
        [router, search, path],
    );
    return { search, update };
}
