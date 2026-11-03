import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "./client";
import { keys } from "./queries";
import type { components } from "./schema";

type Schemas = components["schemas"];

export type ModelCacheInfo = Schemas["ModelCacheInfo"];
export type CachePlanInfo = Schemas["CachePlanInfo"];
export type CachedBaseInfo = Schemas["CachedBaseInfo"];
export type ModelCacheSettings = Schemas["ModelCacheSettings"];

export const cacheKeys = {
    usage: ["models", "cache"] as const,
    settings: ["settings", "model-cache"] as const,
};

export function useModelCache() {
    return useQuery({
        queryKey: cacheKeys.usage,
        queryFn: () => unwrap(api.GET("/api/models/cache")),
    });
}

export function useCacheSettings() {
    return useQuery({
        queryKey: cacheKeys.settings,
        queryFn: () => unwrap(api.GET("/api/settings/model-cache")),
    });
}

export function useSaveCacheSettings() {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (body: ModelCacheSettings) =>
            unwrap(api.PUT("/api/settings/model-cache", { body })),
        onSuccess: async (saved) => {
            client.setQueryData(cacheKeys.settings, saved);
            await client.invalidateQueries({ queryKey: cacheKeys.usage });
        },
    });
}

export function useFreeUpSpace() {
    const client = useQueryClient();
    return useMutation({
        mutationFn: () => unwrap(api.POST("/api/models/cache/free")),
        onSuccess: () => client.invalidateQueries({ queryKey: keys.models }),
    });
}

export function usePinBase() {
    const client = useQueryClient();
    return useMutation({
        mutationFn: ({ key, pinned }: { key: string; pinned: boolean }) =>
            unwrap(
                api.POST("/api/models/base/{key}/pin", {
                    params: { path: { key } },
                    body: { pinned },
                }),
            ),
        onSuccess: () => client.invalidateQueries({ queryKey: keys.models }),
    });
}

export function estimateDownload(size: number): Promise<CachePlanInfo> {
    return unwrap(api.POST("/api/models/cache/estimate", { body: { size_bytes: size } }));
}

export function useDownloadEstimate(size: number | null | undefined) {
    return useQuery({
        queryKey: [...cacheKeys.usage, "estimate", size ?? 0] as const,
        queryFn: () => estimateDownload(size ?? 0),
        enabled: Boolean(size),
    });
}
