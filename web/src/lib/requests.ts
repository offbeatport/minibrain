import type { Tone } from "~/components/models/StatusText";

export const OVERVIEW_PATH = "/monitor";
export const JOBS_PATH = "/monitor/jobs";
export const REQUESTS_PATH = "/monitor/requests";
export const SECURITY_PATH = "/settings/security";
export const REQUEST_KEYS = ["model", "version", "key", "status", "range", "q", "request"] as const;
export const OVERVIEW_KEYS = ["model", "range"] as const;

export type StatusClass = "ok" | "client_error" | "server_error";

export const STATUS_CLASSES: { value: StatusClass; label: string }[] = [
    { value: "ok", label: "OK" },
    { value: "client_error", label: "Client error (4xx)" },
    { value: "server_error", label: "Server error (5xx)" },
];

export const STATUS_TONES: Record<StatusClass, Tone> = {
    ok: "success",
    client_error: "warning",
    server_error: "destructive",
};

const HOUR_MS = 3600 * 1000;

export type TimeRange = { value: string; label: string; phrase: string; span: number | null };

const DAY: TimeRange = {
    value: "24h",
    label: "Last 24 hours",
    phrase: "in the last 24 hours",
    span: 24 * HOUR_MS,
};

export const RANGES: TimeRange[] = [
    {
        value: "15m",
        label: "Last 15 minutes",
        phrase: "in the last 15 minutes",
        span: HOUR_MS / 4,
    },
    { value: "1h", label: "Last hour", phrase: "in the last hour", span: HOUR_MS },
    DAY,
    { value: "7d", label: "Last 7 days", phrase: "in the last 7 days", span: 7 * 24 * HOUR_MS },
    { value: "30d", label: "Last 30 days", phrase: "in the last 30 days", span: 30 * 24 * HOUR_MS },
    { value: "all", label: "All kept logs", phrase: "in the kept logs", span: null },
];

export const DEFAULT_RANGE = DAY.value;

export function rangeOf(value: string | undefined): TimeRange {
    return RANGES.find((range) => range.value === value) ?? DAY;
}

export function sinceOf(value: string | undefined): string | undefined {
    const { span } = rangeOf(value);
    return span ? new Date(Date.now() - span).toISOString() : undefined;
}

const CLOCK = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
});
const DAY_CLOCK = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
});

export function clockTime(value: string, now: Date = new Date()): string {
    const moment = new Date(value);
    return moment.toDateString() === now.toDateString()
        ? CLOCK.format(moment)
        : DAY_CLOCK.format(moment);
}

export function modelLabel(row: { model_key: string; version: number | null }): string {
    return row.version === null ? row.model_key : `${row.model_key}@${row.version}`;
}
