import { useQuery } from "@tanstack/react-query";
import { type JobInfo, type ModelRow, type VersionInfo, api, unwrap } from "./client";

const ACTIVE_JOB = new Set(["queued", "running"]);
const ACTIVE_VERSION = new Set(["training", "evaluating"]);
const POLL_MS = 2000;

export const keys = {
    minibrains: ["minibrains"] as const,
    minibrain: (slug: string) => ["minibrain", slug] as const,
    preview: (slug: string) => ["minibrain", slug, "preview"] as const,
    golden: (slug: string) => ["minibrain", slug, "golden"] as const,
    versions: (slug: string) => ["minibrain", slug, "versions"] as const,
    jobs: (slug: string) => ["minibrain", slug, "jobs"] as const,
    keys: (slug: string) => ["minibrain", slug, "keys"] as const,
    models: ["models"] as const,
    catalog: ["catalog"] as const,
    baseModel: (key: string) => ["models", "base", key] as const,
};

const MOVING_MODEL = new Set(["downloading", "importing"]);
const MOVING_ACTIVITY = new Set(["running", "queued"]);

export function isModelMoving(row: ModelRow): boolean {
    return (
        MOVING_MODEL.has(row.availability.state) ||
        MOVING_ACTIVITY.has(row.activity.state) ||
        row.deployment.state === "starting"
    );
}

const path = (slug: string) => ({ params: { path: { slug } } });

export function isActiveJob(job: JobInfo): boolean {
    return ACTIVE_JOB.has(job.status);
}

export function isActiveVersion(version: VersionInfo): boolean {
    return ACTIVE_VERSION.has(version.status);
}

export function useMinibrains() {
    return useQuery({
        queryKey: keys.minibrains,
        queryFn: () => unwrap(api.GET("/api/minibrains")),
        refetchInterval: (query) =>
            query.state.data?.some((item) => item.active_jobs > 0) ? POLL_MS : false,
    });
}

export function useMinibrain(slug: string) {
    return useQuery({
        queryKey: keys.minibrain(slug),
        queryFn: () => unwrap(api.GET("/api/minibrains/{slug}", path(slug))),
        refetchInterval: (query) => ((query.state.data?.active_jobs ?? 0) > 0 ? POLL_MS : false),
    });
}

export function usePreview(slug: string, enabled: boolean) {
    return useQuery({
        queryKey: keys.preview(slug),
        queryFn: () => unwrap(api.GET("/api/minibrains/{slug}/preview", path(slug))),
        enabled,
        retry: false,
    });
}

export function useGolden(slug: string, enabled: boolean) {
    return useQuery({
        queryKey: keys.golden(slug),
        queryFn: () => unwrap(api.GET("/api/minibrains/{slug}/golden", path(slug))),
        enabled,
    });
}

export function useVersions(slug: string) {
    return useQuery({
        queryKey: keys.versions(slug),
        queryFn: () => unwrap(api.GET("/api/minibrains/{slug}/versions", path(slug))),
        refetchInterval: (query) => (query.state.data?.some(isActiveVersion) ? POLL_MS : false),
    });
}

export function useJobs(slug: string) {
    return useQuery({
        queryKey: keys.jobs(slug),
        queryFn: () => unwrap(api.GET("/api/jobs", { params: { query: { minibrain: slug } } })),
        refetchInterval: (query) => (query.state.data?.some(isActiveJob) ? POLL_MS : false),
    });
}

export function useKeys(slug: string) {
    return useQuery({
        queryKey: keys.keys(slug),
        queryFn: () => unwrap(api.GET("/api/minibrains/{slug}/keys", path(slug))),
    });
}

export function useRecentJobs(limit = 15) {
    return useQuery({
        queryKey: ["jobs", limit] as const,
        queryFn: () => unwrap(api.GET("/api/jobs", { params: { query: { limit } } })),
        refetchInterval: (query) => (query.state.data?.some(isActiveJob) ? POLL_MS : false),
    });
}

export function useSystem() {
    return useQuery({
        queryKey: ["system"] as const,
        queryFn: () => unwrap(api.GET("/api/system")),
        refetchInterval: 5000,
    });
}

export function useInstallSettings() {
    return useQuery({
        queryKey: ["settings"] as const,
        queryFn: () => unwrap(api.GET("/api/settings")),
    });
}

export function useModels(archived: boolean) {
    return useQuery({
        queryKey: [...keys.models, { archived }],
        queryFn: () => unwrap(api.GET("/api/models", { params: { query: { archived } } })),
        refetchInterval: (query) => (query.state.data?.some(isModelMoving) ? POLL_MS : 15000),
    });
}

export function useCatalog() {
    return useQuery({
        queryKey: keys.catalog,
        queryFn: () => unwrap(api.GET("/api/catalog")),
        refetchInterval: (query) => {
            const moving = query.state.data?.entries.some((entry) =>
                entry.added.some((added) => MOVING_MODEL.has(added.availability.state)),
            );
            const sync = query.state.data?.sync_job;
            return moving || (sync && isActiveJob(sync)) ? POLL_MS : 30000;
        },
    });
}

export function useBaseModel(key: string) {
    return useQuery({
        queryKey: keys.baseModel(key),
        queryFn: () => unwrap(api.GET("/api/models/base/{key}", { params: { path: { key } } })),
        refetchInterval: (query) =>
            query.state.data && isModelMoving(query.state.data) ? POLL_MS : 15000,
    });
}

export function useBases() {
    return useQuery({
        queryKey: ["minibrains", "bases"],
        queryFn: () => unwrap(api.GET("/api/minibrains/bases")),
    });
}

export function useModelSources() {
    return useQuery({
        queryKey: ["models", "sources"],
        queryFn: () => unwrap(api.GET("/api/models/sources")),
    });
}
