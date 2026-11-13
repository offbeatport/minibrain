export const TRAINING_PATH = "/training";
export const JOBS_PATH = "/jobs";
export const API_KEYS_PATH = "/api-keys";
const TRAIN_KIND = "train";

export type TrainMethod = "sft" | "instructions";

export type TrainFrom = { from?: number; data?: number; method?: TrainMethod };

export function trainHref(slug: string, opts: TrainFrom = {}): string {
    const search = new URLSearchParams();
    if (opts.from !== undefined) {
        search.set("from", String(opts.from));
    }
    if (opts.data !== undefined) {
        search.set("data", String(opts.data));
    }
    if (opts.method === "instructions") {
        search.set("method", opts.method);
    }
    const query = search.toString();
    return `/models/${encodeURIComponent(slug)}/train${query ? `?${query}` : ""}`;
}

export function evaluationsHref(slug: string): string {
    return `/evaluations?model=${encodeURIComponent(slug)}`;
}

export function playgroundHref(slug: string): string {
    return `/playground?model=${encodeURIComponent(slug)}`;
}

export function modelDataHref(slug: string): string {
    return `/data?model=${encodeURIComponent(slug)}`;
}

export const REQUEST_BODIES_ID = "request-bodies";

export const API_REFERENCE_PATH = "/developers";

export const MANAGEMENT_REFERENCE_PATH = "/developers/management";

export function deploymentPageHref(slug: string): string {
    return modelPageHref(slug, "api");
}

export function modelCardHref(slug: string, number: number): string {
    return `/models/${encodeURIComponent(slug)}/versions/${number}/card`;
}

export function modelCardDownloadHref(slug: string, number: number, format: "md" | "json"): string {
    return `/api/models/${encodeURIComponent(slug)}/versions/${number}/card.${format}`;
}

export function modelAibomHref(slug: string, number: number): string {
    return `/api/models/${encodeURIComponent(slug)}/versions/${number}/aibom.json`;
}

export function jobHref(job: { id: number; kind: string }): string {
    return `${job.kind === TRAIN_KIND ? TRAINING_PATH : JOBS_PATH}/${job.id}`;
}

export type ModelTab = "overview" | "versions" | "monitoring" | "api" | "settings" | "files";

export function modelPageHref(name: string, tab: ModelTab = "overview"): string {
    const page = `/models/${encodeURIComponent(name)}`;
    return tab === "overview" ? page : `${page}/${tab}`;
}

export function modelVersionHref(name: string, number: number): string {
    return `/models/${encodeURIComponent(name)}/versions/${number}`;
}

export function modelCompareHref(name: string, a: number, b: number): string {
    return `/models/${encodeURIComponent(name)}/compare?a=${a}&b=${b}`;
}

export function auditHref(name: string): string {
    return `/settings/audit?target=${encodeURIComponent(name)}`;
}

export function requestLogHref(search: Record<string, string>): string {
    return `/monitor/requests?${new URLSearchParams(search).toString()}`;
}

export function versionPlaygroundHref(name: string, number: number): string {
    return playgroundHref(`${name}@${number}`);
}
