import { useRouter, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo } from "react";

const KEYS = [
    "q",
    "type",
    "availability",
    "deployment",
    "tag",
    "archived",
    "task",
    "provider",
    "fits",
    "access",
    "tier",
    "pool",
] as const;

export type ModelsSearchKey = (typeof KEYS)[number];
export type ModelsSearch = Partial<Record<ModelsSearchKey, string>>;

export type ModelsPath = "/models" | "/discover";

function storageKey(path: ModelsPath): string {
    return `minibrain${path.replace("/", ".")}.search`;
}

export function readModelsSearch(search: unknown): ModelsSearch {
    const source = (search ?? {}) as Record<string, unknown>;
    const found: ModelsSearch = {};
    for (const key of KEYS) {
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

function remembered(path: ModelsPath): string {
    try {
        return window.sessionStorage.getItem(storageKey(path)) ?? "";
    } catch {
        return "";
    }
}

export function useModelsSearch(path: ModelsPath) {
    const router = useRouter();
    const raw = useRouterState({
        select: (state) => searchString(readModelsSearch(state.location.search)),
    });
    useEffect(() => {
        const saved = remembered(path);
        if (!raw && saved) {
            router.history.replace(`${path}${saved}`);
        }
    }, [raw, router, path]);
    const search = useMemo(
        () => readModelsSearch(Object.fromEntries(new URLSearchParams(raw))),
        [raw],
    );
    const update = useCallback(
        (patch: ModelsSearch) => {
            const next = { ...search, ...patch };
            for (const key of KEYS) {
                if (!next[key]) {
                    delete next[key];
                }
            }
            remember(path, next);
            router.history.replace(`${path}${searchString(next)}`);
        },
        [router, search, path],
    );
    return { search, update };
}
