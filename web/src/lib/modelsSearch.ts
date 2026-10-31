import { useRouter, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo } from "react";

const KEYS = [
    "tab",
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
] as const;

export type ModelsSearchKey = (typeof KEYS)[number];
export type ModelsSearch = Partial<Record<ModelsSearchKey, string>>;

const STORAGE_KEY = "minibrain.models.search";

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

function remember(search: ModelsSearch): void {
    try {
        window.sessionStorage.setItem(STORAGE_KEY, searchString(search));
    } catch {
        return;
    }
}

export function modelsHref(): string {
    return `/models${remembered()}`;
}

function remembered(): string {
    try {
        return window.sessionStorage.getItem(STORAGE_KEY) ?? "";
    } catch {
        return "";
    }
}

export function useModelsSearch() {
    const router = useRouter();
    const raw = useRouterState({
        select: (state) => searchString(readModelsSearch(state.location.search)),
    });
    useEffect(() => {
        const saved = remembered();
        if (!raw && saved) {
            router.history.replace(`/models${saved}`);
        }
    }, [raw, router]);
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
            remember(next);
            router.history.replace(`/models${searchString(next)}`);
        },
        [router, search],
    );
    return { search, update };
}
