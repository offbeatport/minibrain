import { useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import type { MinibrainSummary } from "~/api/client";
import { useMinibrains } from "~/api/queries";

const STORAGE_KEY = "minibrain.selected";

export function readMinibrainParam(search: unknown): string | undefined {
    const value = (search as { minibrain?: unknown } | undefined)?.minibrain;
    return typeof value === "string" && value ? value : undefined;
}

export function rememberedMinibrain(): string | null {
    try {
        return window.localStorage.getItem(STORAGE_KEY);
    } catch {
        return null;
    }
}

function remember(slug: string): void {
    try {
        window.localStorage.setItem(STORAGE_KEY, slug);
    } catch {
        return;
    }
}

function withMinibrain(pathname: string, slug: string): string {
    return `${pathname}?minibrain=${encodeURIComponent(slug)}`;
}

function resolve(requested: string | undefined, minibrains: MinibrainSummary[]): string | null {
    const known = new Set(minibrains.map((item) => item.slug));
    const candidates = [requested, rememberedMinibrain(), minibrains[0]?.slug];
    return candidates.find((slug): slug is string => Boolean(slug && known.has(slug))) ?? null;
}

export function useSelectedMinibrain() {
    const router = useRouter();
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    const requested = useRouterState({
        select: (state) => readMinibrainParam(state.location.search),
    });
    const { data, isLoading } = useMinibrains();
    const minibrains = data ?? [];
    const slug = data ? resolve(requested, minibrains) : null;
    useEffect(() => {
        if (!slug) {
            return;
        }
        remember(slug);
        if (slug !== requested) {
            router.history.replace(withMinibrain(pathname, slug));
        }
    }, [slug, requested, pathname, router]);
    const select = (next: string) => router.history.push(withMinibrain(pathname, next));
    return { slug, select, minibrains, loading: isLoading };
}
