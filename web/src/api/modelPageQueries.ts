import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query";
import type { TrafficRange } from "~/lib/traffic";
import { api, unwrap } from "./client";
import type { components } from "./schema";

type Schemas = components["schemas"];

export type ModelActivityEvent = Schemas["ModelActivityEvent"];
export type ModelStatus = Schemas["ModelStatus"];
export type StatusAction = Schemas["StatusAction"];

const REFRESH_MS = 30_000;

export function useModelTraffic(name: string, range: TrafficRange) {
    return useQuery({
        queryKey: ["all-models", "traffic", name, range],
        queryFn: () =>
            unwrap(
                api.GET("/api/model-pages/{name}/traffic", {
                    params: { path: { name }, query: { range } },
                }),
            ),
        placeholderData: keepPreviousData,
        refetchInterval: REFRESH_MS,
        enabled: name !== "",
    });
}

export function useModelActivity(name: string, limit = 40) {
    return useQuery({
        queryKey: ["all-models", "activity", name, limit],
        queryFn: () =>
            unwrap(
                api.GET("/api/model-pages/{name}/activity", {
                    params: { path: { name }, query: { limit } },
                }),
            ),
        refetchInterval: REFRESH_MS,
        enabled: name !== "",
    });
}

export function useJobsMetrics(ids: number[], live: (id: number) => boolean) {
    return useQueries({
        queries: ids.map((id) => ({
            queryKey: ["jobs", "metrics", id],
            queryFn: () =>
                unwrap(api.GET("/api/jobs/{job_id}/metrics", { params: { path: { job_id: id } } })),
            refetchInterval: live(id) ? 5000 : (false as const),
        })),
    });
}
