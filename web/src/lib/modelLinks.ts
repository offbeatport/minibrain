import type { JobInfo } from "~/api/client";

export function trainingHref(slug: string): string {
    return `/training/${encodeURIComponent(slug)}`;
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
    return `/deployments/${encodeURIComponent(slug)}`;
}

export function modelCardHref(slug: string, number: number): string {
    return `/models/custom/${encodeURIComponent(slug)}/versions/${number}/card`;
}

export function modelCardDownloadHref(slug: string, number: number, format: "md" | "json"): string {
    return `/api/models/${encodeURIComponent(slug)}/versions/${number}/card.${format}`;
}

export function modelAibomHref(slug: string, number: number): string {
    return `/api/models/${encodeURIComponent(slug)}/versions/${number}/aibom.json`;
}

export function jobHref(job: JobInfo): string {
    return `/jobs/${job.id}`;
}
