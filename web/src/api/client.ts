import createClient from "openapi-fetch";
import type { components, paths } from "./schema";

type Schemas = components["schemas"];

export type MinibrainSummary = Schemas["MinibrainSummary"];
export type MinibrainDetail = Schemas["MinibrainDetail"];
export type VersionInfo = Schemas["VersionInfo"];
export type JobInfo = Schemas["JobInfo"];
export type PreviewResponse = Schemas["PreviewResponse"];
export type QueryResponse = Schemas["QueryResponse"];
export type SnapshotInfo = Schemas["SnapshotInfo"];
export type ExampleInfo = Schemas["ExampleInfo"];
export type KeyInfo = Schemas["KeyInfo"];
export type KeyCreated = Schemas["KeyCreated"];
export type ModelRef = Schemas["ModelRef"];
export type ModelStage = Schemas["Stage"];
export type ModelUsage = Schemas["Usage"];
export type ModelVersionRow = Schemas["VersionRow"];
export type DatasetSummary = Schemas["DatasetSummary"];
export type SourceSummary = Schemas["SourceSummary"];
export type MappingInfo = Schemas["MappingInfo"];
export type LabelCount = Schemas["LabelCount"];
export type ColumnStats = Schemas["ColumnStats"];
export type CompleteResponse = Schemas["CompleteResponse"];
export type SplitScore = Schemas["SplitScore"];
export type ModelRow = Schemas["ModelRow"];
export type BaseModelDetail = Schemas["BaseModelDetail"];
export type CatalogResponse = Schemas["CatalogResponse"];
export type CatalogEntry = Schemas["CatalogEntry"];
export type CatalogVariantInfo = Schemas["CatalogVariantInfo"];
export type HardwareInfo = Schemas["HardwareInfo"];
export type FitInfo = Schemas["FitInfo"];

export const CSRF_HEADER = "X-CSRF-Token";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const signedOutListeners = new Set<() => void>();
let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
    csrfToken = token;
}

export function onSignedOut(listener: () => void): () => void {
    signedOutListeners.add(listener);
    return () => signedOutListeners.delete(listener);
}

function guarded(method: string, headers: Headers): Headers {
    if (csrfToken && !SAFE_METHODS.has(method.toUpperCase())) {
        headers.set(CSRF_HEADER, csrfToken);
    }
    return headers;
}

let signedOutReason: string | null = null;

function reasonText(header: string): string | null {
    const [kind, amount] = header.split(":");
    const count = Number(amount);
    if (kind === "idle" && count > 0) {
        return count % 60 === 0
            ? `You were signed out after ${count / 60} ${count === 60 ? "hour" : "hours"} without activity.`
            : `You were signed out after ${count} minutes without activity.`;
    }
    if (kind === "expired" && count > 0) {
        return count % 24 === 0
            ? `Your sign-in reached its ${count / 24}-day limit.`
            : `Your sign-in reached its ${count}-hour limit.`;
    }
    return null;
}

export function signOutReason(): string | null {
    return signedOutReason;
}

export function clearSignOutReason(): void {
    signedOutReason = null;
}

function noticeSignedOut(response: Response): Response {
    const ended = response.headers.get("x-signed-out");
    if (ended) {
        signedOutReason = reasonText(ended) ?? signedOutReason;
    }
    if (response.status === 401 || ended) {
        for (const listener of signedOutListeners) {
            listener();
        }
    }
    return response;
}

export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const method = init.method ?? "GET";
    const headers = guarded(method, new Headers(init.headers));
    return noticeSignedOut(await fetch(url, { ...init, headers }));
}

export const api = createClient<paths>();

api.use({
    onRequest({ request }) {
        guarded(request.method, request.headers);
        return request;
    },
    onResponse({ response }) {
        return noticeSignedOut(response);
    },
});

type Failure = { detail?: unknown };
type Outcome<T> = { data?: T; error?: unknown; response: Response };

function describeError(error: unknown, status: number): string {
    const detail = (error as Failure | undefined)?.detail;
    if (typeof detail === "string") {
        return detail;
    }
    if (Array.isArray(detail)) {
        return detail.map((item) => (item as { msg?: string })?.msg ?? String(item)).join("; ");
    }
    return `Request failed (${status})`;
}

export async function unwrap<T>(request: Promise<Outcome<T>>): Promise<T> {
    const { data, error, response } = await request;
    if (!response.ok || data === undefined) {
        throw new Error(describeError(error, response.status));
    }
    return data;
}

export async function succeed(request: Promise<Outcome<unknown>>): Promise<void> {
    const { error, response } = await request;
    if (!response.ok) {
        throw new Error(describeError(error, response.status));
    }
}

export async function removed(request: Promise<Outcome<unknown>>): Promise<void> {
    const { error, response } = await request;
    if (!response.ok && response.status !== 404) {
        throw new Error(describeError(error, response.status));
    }
}

export async function uploadSource(slug: string, file: File): Promise<MinibrainDetail> {
    const form = new FormData();
    form.append("file", file);
    const response = await apiFetch(`/api/minibrains/${encodeURIComponent(slug)}/source`, {
        method: "POST",
        body: form,
    });
    const body: unknown = await response.json();
    if (!response.ok) {
        throw new Error(describeError(body, response.status));
    }
    return body as MinibrainDetail;
}

export async function uploadFile(file: File): Promise<SourceSummary> {
    const form = new FormData();
    form.append("file", file);
    const response = await apiFetch("/api/sources", { method: "POST", body: form });
    const body: unknown = await response.json();
    if (!response.ok) {
        throw new Error(describeError(body, response.status));
    }
    return body as SourceSummary;
}

export function jobEventsUrl(jobId: number): string {
    return `/api/jobs/${jobId}/events`;
}
