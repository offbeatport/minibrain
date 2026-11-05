import { useRouter, useRouterState } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

export type ListSearch<K extends string> = Partial<Record<K, string>>;

function hrefWith(path: string, params: URLSearchParams): string {
    const text = params.toString().replaceAll("%2C", ",").replaceAll("%40", "@");
    return text ? `${path}?${text}` : path;
}

export function listHref(path: string, search: Record<string, string | undefined>): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(search)) {
        if (value) {
            params.set(key, value);
        }
    }
    return hrefWith(path, params);
}

export function splitList(value: string | undefined): string[] {
    return value ? value.split(",").filter(Boolean) : [];
}

export function useSearchParam(key: string): string | null {
    return useRouterState({
        select: (state) => new URLSearchParams(state.location.searchStr).get(key),
    });
}

export function useListSearch<K extends string>(path: string, keys: readonly K[]) {
    const router = useRouter();
    const raw = useRouterState({ select: (state) => state.location.searchStr });
    const search = useMemo(() => {
        const params = new URLSearchParams(raw);
        const found: ListSearch<K> = {};
        for (const key of keys) {
            const value = params.get(key);
            if (value) {
                found[key] = value;
            }
        }
        return found;
    }, [raw, keys]);
    const update = useCallback(
        (patch: ListSearch<K>) => router.history.replace(listHref(path, { ...search, ...patch })),
        [router, path, search],
    );
    const open = useCallback(
        (patch: ListSearch<K>) => router.history.push(listHref(path, { ...search, ...patch })),
        [router, path, search],
    );
    return { search, update, open };
}
