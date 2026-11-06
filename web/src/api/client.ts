import createClient from "openapi-fetch";
import type { components, paths } from "./schema";

type Schemas = components["schemas"];

export type ModelSummary = Schemas["ModelSummary"];
export type ModelDetail = Schemas["ModelDetail"];
export type ModelCreate = Schemas["ModelCreate"];
export type LabelProposal = Schemas["LabelProposal"];
export type VersionInfo = Schemas["VersionInfo"];
export type JobInfo = Schemas["JobInfo"];
export type PreviewResponse = Schemas["PreviewResponse"];
export type QueryResponse = Schemas["QueryResponse"];
export type DatasetVersionInfo = Schemas["DatasetVersionInfo"];
export type ExampleInfo = Schemas["ExampleInfo"];
export type KeyInfo = Schemas["KeyInfo"];
export type KeyCreated = Schemas["KeyCreated"];
export type ModelRef = Schemas["ModelRef"];
export type ModelUsage = Schemas["Usage"];
export type ModelVersionRow = Schemas["VersionRow"];
export type DatasetSummary = Schemas["DatasetSummary"];
export type SourceSummary = Schemas["SourceSummary"];
export type SourceAdded = Schemas["SourceAdded"];
export type NameTaken = Schemas["NameTaken"];
export type NameTakenInfo = Schemas["NameTakenInfo"];
export type Uploaded = SourceAdded | { outcome: "name_taken"; taken: NameTakenInfo };
export type MappingInfo = Schemas["MappingInfo"];
export type LabelCount = Schemas["LabelCount"];
export type ColumnStats = Schemas["ColumnStats"];
export type CompleteResponse = Schemas["CompleteResponse"];
export type SplitScore = Schemas["SplitScore"];
export type PresetInfo = Schemas["PresetInfo"];
export type PresetsResponse = Schemas["PresetsResponse"];
export type GraderConfig = Schemas["GraderConfig"];
export type PromotionInfo = Schemas["PromotionInfo"];
export type ThresholdInfo = Schemas["ThresholdInfo"];
export type ContractInfo = Schemas["ContractInfo"];
export type JudgeInfo = Schemas["JudgeInfo"];
export type RuleCheck = Schemas["RuleCheckInfo"];
export type VersionAnswers = Schemas["VersionAnswers"];
export type ExampleAnswer = Schemas["ExampleAnswer"];
export type AnswerSide = Schemas["AnswerSide"];
export type ModelRow = Schemas["ModelRow"];
export type BaseModelDetail = Schemas["BaseModelDetail"];
export type CatalogResponse = Schemas["CatalogResponse"];
export type CatalogEntry = Schemas["CatalogEntry"];
export type CatalogVariantInfo = Schemas["CatalogVariantInfo"];
export type HardwareInfo = Schemas["HardwareInfo"];
export type FitInfo = Schemas["FitInfo"];
export type TrainFitInfo = Schemas["TrainFitInfo"];
export type TrainingPlanInfo = Schemas["TrainingPlanInfo"];
export type TrainingOptionInfo = Schemas["TrainingOptionInfo"];
export type VersionCreate = Schemas["VersionCreate"];

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

export function withCsrf(request: Request): Request {
    return new Request(request, { headers: guarded(request.method, new Headers(request.headers)) });
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

export async function uploadSource(slug: string, file: File): Promise<ModelDetail> {
    const form = new FormData();
    form.append("file", file);
    const response = await apiFetch(`/api/models/${encodeURIComponent(slug)}/source`, {
        method: "POST",
        body: form,
    });
    const body: unknown = await response.json();
    if (!response.ok) {
        throw new Error(describeError(body, response.status));
    }
    return body as ModelDetail;
}

function isNameTaken(body: unknown): body is NameTakenInfo {
    return typeof (body as Partial<NameTakenInfo> | null)?.suggestion === "string";
}

export async function uploadFile(
    file: File,
    nameTaken: NameTaken = "keep_both",
): Promise<Uploaded> {
    const form = new FormData();
    form.append("file", file);
    const response = await apiFetch(`/api/sources?name_taken=${nameTaken}`, {
        method: "POST",
        body: form,
    });
    const body: unknown = await response.json();
    if (response.status === 409 && isNameTaken(body)) {
        return { outcome: "name_taken", taken: body };
    }
    if (!response.ok) {
        throw new Error(describeError(body, response.status));
    }
    return body as SourceAdded;
}

export function jobEventsUrl(jobId: number): string {
    return `/api/jobs/${jobId}/events`;
}
