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
export type CompleteResponse = Schemas["CompleteResponse"];
export type SplitScore = Schemas["SplitScore"];

export const api = createClient<paths>();

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

export async function uploadSource(slug: string, file: File): Promise<MinibrainDetail> {
    const form = new FormData();
    form.append("file", file);
    const response = await fetch(`/api/minibrains/${encodeURIComponent(slug)}/source`, {
        method: "POST",
        body: form,
    });
    const body: unknown = await response.json();
    if (!response.ok) {
        throw new Error(describeError(body, response.status));
    }
    return body as MinibrainDetail;
}

export function jobEventsUrl(jobId: number): string {
    return `/api/jobs/${jobId}/events`;
}
