import { useQuery } from "@tanstack/react-query";
import { type JobInfo, type ModelRow, type VersionInfo, api, unwrap } from "./client";

const ACTIVE_JOB = new Set(["queued", "running"]);
const ACTIVE_VERSION = new Set(["training", "evaluating"]);
const POLL_MS = 2000;
export const MODELS_POLL_MS = POLL_MS;

export const keys = {
    models: ["models"] as const,
    model: (slug: string) => ["model", slug] as const,
    preview: (slug: string) => ["model", slug, "preview"] as const,
    golden: (slug: string) => ["model", slug, "golden"] as const,
    versions: (slug: string) => ["model", slug, "versions"] as const,
    jobs: (slug: string) => ["model", slug, "jobs"] as const,
    apiKeys: ["keys"] as const,
    allModels: ["all-models"] as const,
    catalog: ["catalog"] as const,
    baseModel: (key: string) => ["all-models", "base", key] as const,
    datasets: ["datasets"] as const,
    dataset: (slug: string) => ["datasets", slug] as const,
    datasetPreview: (slug: string) => ["datasets", slug, "preview"] as const,
    sources: ["sources"] as const,
    sourceRows: (id: number) => ["sources", id, "rows"] as const,
    sourceStats: (id: number) => ["sources", id, "stats"] as const,
    presets: ["presets"] as const,
};

const MOVING_MODEL = new Set(["downloading", "importing"]);
const MOVING_ACTIVITY = new Set(["running", "queued"]);

export function isModelMoving(row: ModelRow): boolean {
    return (
        MOVING_MODEL.has(row.availability.state) ||
        MOVING_ACTIVITY.has(row.activity.state) ||
        row.deployment.state === "starting" ||
        row.teardown?.state === "running"
    );
}

export function loadAllModels() {
    return unwrap(api.GET("/api/all-models"));
}

const path = (slug: string) => ({ params: { path: { slug } } });

export function isActiveJob(job: JobInfo): boolean {
    return ACTIVE_JOB.has(job.status);
}

export function isActiveVersion(version: VersionInfo): boolean {
    return ACTIVE_VERSION.has(version.status);
}

export function useModels() {
    return useQuery({
        queryKey: keys.models,
        queryFn: () => unwrap(api.GET("/api/models")),
        refetchInterval: (query) =>
            query.state.data?.some((item) => item.active_jobs > 0) ? POLL_MS : false,
    });
}

export function useModel(slug: string) {
    return useQuery({
        queryKey: keys.model(slug),
        queryFn: () => unwrap(api.GET("/api/models/{slug}", path(slug))),
        refetchInterval: (query) => ((query.state.data?.active_jobs ?? 0) > 0 ? POLL_MS : false),
    });
}

export function usePreview(slug: string, enabled: boolean) {
    return useQuery({
        queryKey: keys.preview(slug),
        queryFn: () => unwrap(api.GET("/api/models/{slug}/preview", path(slug))),
        enabled,
        retry: false,
    });
}

export function useDatasets() {
    return useQuery({ queryKey: keys.datasets, queryFn: () => unwrap(api.GET("/api/datasets")) });
}

export function useSamples() {
    return useQuery({
        queryKey: ["samples"],
        queryFn: () => unwrap(api.GET("/api/samples")),
        staleTime: Number.POSITIVE_INFINITY,
    });
}

export function useSources() {
    return useQuery({ queryKey: keys.sources, queryFn: () => unwrap(api.GET("/api/sources")) });
}

const sourcePath = (id: number) => ({ params: { path: { source_id: id } } });

export function useSourceRows(id: number) {
    return useQuery({
        queryKey: keys.sourceRows(id),
        queryFn: () => unwrap(api.GET("/api/sources/{source_id}/rows", sourcePath(id))),
        retry: false,
    });
}

export function useSourceStats(id: number) {
    return useQuery({
        queryKey: keys.sourceStats(id),
        queryFn: () => unwrap(api.GET("/api/sources/{source_id}/stats", sourcePath(id))),
        retry: false,
    });
}

export function useDataset(slug: string) {
    return useQuery({
        queryKey: keys.dataset(slug),
        queryFn: () => unwrap(api.GET("/api/datasets/{slug}", path(slug))),
    });
}

export function useDatasetPreview(slug: string, enabled: boolean) {
    return useQuery({
        queryKey: keys.datasetPreview(slug),
        queryFn: () => unwrap(api.GET("/api/datasets/{slug}/preview", path(slug))),
        enabled,
        retry: false,
    });
}

export function useGolden(slug: string, enabled: boolean) {
    return useQuery({
        queryKey: keys.golden(slug),
        queryFn: () => unwrap(api.GET("/api/models/{slug}/golden", path(slug))),
        enabled,
    });
}

export function useVersions(slug: string) {
    return useQuery({
        queryKey: keys.versions(slug),
        queryFn: () => unwrap(api.GET("/api/models/{slug}/versions", path(slug))),
        refetchInterval: (query) => (query.state.data?.some(isActiveVersion) ? POLL_MS : false),
    });
}

export function useJobs(slug: string) {
    return useQuery({
        queryKey: keys.jobs(slug),
        queryFn: () =>
            unwrap(api.GET("/api/jobs", { params: { query: { model: [slug] } } })).then(
                (page) => page.items,
            ),
        refetchInterval: (query) => (query.state.data?.some(isActiveJob) ? POLL_MS : false),
    });
}

export function useJob(id: number | null) {
    return useQuery({
        queryKey: ["jobs", "detail", id] as const,
        queryFn: () =>
            unwrap(api.GET("/api/jobs/{job_id}", { params: { path: { job_id: id ?? 0 } } })),
        enabled: id !== null,
        refetchInterval: (query) =>
            query.state.data && isActiveJob(query.state.data) ? POLL_MS : false,
    });
}

export function useKeys() {
    return useQuery({ queryKey: keys.apiKeys, queryFn: () => unwrap(api.GET("/api/keys")) });
}

export function useRecentJobs(limit = 15) {
    return useQuery({
        queryKey: ["jobs", limit] as const,
        queryFn: () =>
            unwrap(api.GET("/api/jobs", { params: { query: { limit } } })).then(
                (page) => page.items,
            ),
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

export function usePools() {
    return useQuery({
        queryKey: ["compute", "pools"] as const,
        queryFn: () => unwrap(api.GET("/api/compute/pools")),
        refetchInterval: 10000,
    });
}

export function useInfrastructure() {
    return useQuery({
        queryKey: ["infrastructure"] as const,
        queryFn: () => unwrap(api.GET("/api/system/infrastructure")),
        refetchInterval: 30000,
    });
}

export function useInstallSettings() {
    return useQuery({
        queryKey: ["settings"] as const,
        queryFn: () => unwrap(api.GET("/api/settings")),
    });
}

export function useAllModels() {
    return useQuery({
        queryKey: keys.allModels,
        queryFn: loadAllModels,
        refetchInterval: (query) => (query.state.data?.some(isModelMoving) ? POLL_MS : 15000),
    });
}

export function useCatalog(pool?: string) {
    return useQuery({
        queryKey: [...keys.catalog, pool ?? ""],
        queryFn: () => unwrap(api.GET("/api/catalog", { params: { query: { pool } } })),
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
        queryFn: () => unwrap(api.GET("/api/base-models/{key}", { params: { path: { key } } })),
        refetchInterval: (query) =>
            query.state.data && isModelMoving(query.state.data) ? POLL_MS : 15000,
    });
}

export function usePresets() {
    return useQuery({
        queryKey: keys.presets,
        queryFn: () => unwrap(api.GET("/api/presets")),
        staleTime: Number.POSITIVE_INFINITY,
    });
}
