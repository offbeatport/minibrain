import type { components } from "~/api/schema";
import {
    LATENCY_COLORS,
    type LineMarker,
    type LineRow,
    type LineSeries,
    OTHER_COLOR,
    SERIES_COLORS,
} from "~/components/charts/LineChart";
import { count } from "~/lib/format";

type Schemas = components["schemas"];

export type TrafficReport = Schemas["ModelTrafficReport"];
export type TrafficStats = Schemas["TrafficStats"];
export type TrafficRange = TrafficReport["range"];
export type TrafficMetric = "requests" | "p95" | "errors" | "cost";

export const RANGES: { key: TrafficRange; label: string }[] = [
    { key: "24h", label: "24h" },
    { key: "7d", label: "7d" },
    { key: "30d", label: "30d" },
];

export const METRICS: { key: TrafficMetric; label: string }[] = [
    { key: "requests", label: "Requests" },
    { key: "p95", label: "p95 latency" },
    { key: "errors", label: "Errors" },
    { key: "cost", label: "Cost" },
];

export const SPAN: Record<TrafficRange, string> = {
    "24h": "in the last 24 hours",
    "7d": "in the last 7 days",
    "30d": "in the last 30 days",
};

export const LAST: Record<TrafficRange, string> = {
    "24h": "The last 24 hours",
    "7d": "The last 7 days",
    "30d": "The last 30 days",
};

export const PERIOD: Record<TrafficRange, string> = {
    "24h": "the 24 hours before",
    "7d": "the 7 days before",
    "30d": "the 30 days before",
};

const HOUR = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const WEEKDAY = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
});
const DAY_HOUR = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
});

const EARLIER = "earlier";
const ALL = "all";
const DAY_SECONDS = 86400;

export function ms(value: number | null | undefined): string {
    return value === null || value === undefined ? "–" : `${count(Math.round(value))} ms`;
}

export function rate(value: number | null | undefined): string {
    return value === null || value === undefined ? "–" : `${(value * 100).toFixed(1)}%`;
}

export function fineRate(value: number): string {
    return `${(value * 100).toFixed(value > 0 && value < 0.01 ? 2 : 1)}%`;
}

export function gpu(seconds: number | null | undefined): string {
    if (seconds === null || seconds === undefined) {
        return "–";
    }
    if (seconds >= 3600) {
        return `${(seconds / 3600).toFixed(1)} GPU·h`;
    }
    return `${seconds.toFixed(seconds < 10 ? 2 : 1)} GPU·s`;
}

export function costPer1k(stats: TrafficStats): number | null {
    return stats.requests > 0 ? (stats.device_seconds * 1000) / stats.requests : null;
}

export function formatOf(metric: TrafficMetric): (value: number) => string {
    if (metric === "requests") {
        return (value) => count(value);
    }
    if (metric === "p95") {
        return ms;
    }
    if (metric === "errors") {
        return fineRate;
    }
    return gpu;
}

export function headline(metric: TrafficMetric, totals: TrafficStats): string {
    if (metric === "requests") {
        return `${count(totals.requests)} ${totals.requests === 1 ? "request" : "requests"}`;
    }
    if (metric === "p95") {
        return `p95 ${ms(totals.p95_ms)}`;
    }
    if (metric === "errors") {
        return `${rate(totals.error_rate ?? 0)} errors`;
    }
    return gpu(totals.device_seconds);
}

const AXIS_NUMBER = new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
});

export function axisFormatOf(metric: TrafficMetric): (value: number) => string {
    if (metric === "p95") {
        return (value) => `${AXIS_NUMBER.format(value)} ms`;
    }
    if (metric === "errors") {
        return (value) => `${Math.round(value * 100)}%`;
    }
    return (value) => AXIS_NUMBER.format(value);
}

export const EMPTY_DOMAIN: Record<TrafficMetric, [number, number]> = {
    requests: [0, 4],
    p95: [0, 400],
    errors: [0, 1],
    cost: [0, 4],
};

export function metricValue(stats: TrafficStats, metric: TrafficMetric): number | null {
    if (stats.requests <= 0) {
        return null;
    }
    if (metric === "requests") {
        return stats.requests;
    }
    if (metric === "p95") {
        return stats.p95_ms ?? null;
    }
    if (metric === "errors") {
        return stats.errors / stats.requests;
    }
    return stats.device_seconds;
}

export function bucketEnd(report: TrafficReport, index: number): number {
    const start = Date.parse(report.buckets[index].at);
    return Math.min(start + report.bucket_seconds * 1000, Date.parse(report.until));
}

export function xFormat(range: TrafficRange): (value: number) => string {
    return (value) => (range === "24h" ? HOUR : DAY).format(new Date(value));
}

export function readoutTitle(report: TrafficReport): (value: number) => string {
    const span = report.bucket_seconds * 1000;
    return (value) => {
        const start = new Date(value - span);
        return report.bucket_seconds >= DAY_SECONDS
            ? WEEKDAY.format(start)
            : `${DAY_HOUR.format(start)} – ${HOUR.format(new Date(value))}`;
    };
}

export function markersOf(report: TrafficReport): LineMarker[] {
    const first = report.buckets.length > 0 ? bucketEnd(report, 0) : 0;
    return report.markers
        .map((marker) => ({ at: Date.parse(marker.at), label: marker.label }))
        .filter((marker) => marker.at > first);
}

export function readoutNotes(report: TrafficReport): ((value: number) => string[]) | undefined {
    const markers = report.markers.map((marker) => ({
        at: Date.parse(marker.at),
        label: marker.label,
    }));
    if (markers.length === 0) {
        return undefined;
    }
    const span = report.bucket_seconds * 1000;
    return (value) =>
        markers
            .filter((item) => item.at <= value && item.at > value - span)
            .map((item) => item.label);
}

export type VersionRef = { number: number; current: boolean; live_at?: string | null };

export function versionColors(versions: VersionRef[]): Map<number, string> {
    const everLive = versions
        .filter((version) => version.current || version.live_at)
        .map((version) => version.number)
        .sort((a, b) => b - a)
        .slice(0, SERIES_COLORS.length);
    return new Map(everLive.map((number, index) => [number, SERIES_COLORS[index]]));
}

type Acc = { requests: number; errors: number; p95: number; seconds: number };

function merged(stats: TrafficStats[]): TrafficStats {
    const acc = stats.reduce<Acc>(
        (total, item) => ({
            requests: total.requests + item.requests,
            errors: total.errors + item.errors,
            p95: total.p95 + (item.p95_ms ?? 0) * item.requests,
            seconds: total.seconds + item.device_seconds,
        }),
        { requests: 0, errors: 0, p95: 0, seconds: 0 },
    );
    return {
        requests: acc.requests,
        errors: acc.errors,
        error_rate: acc.requests > 0 ? acc.errors / acc.requests : null,
        p50_ms: null,
        p95_ms: acc.requests > 0 ? acc.p95 / acc.requests : null,
        p99_ms: null,
        device_seconds: acc.seconds,
    };
}

export type Usage = {
    rows: LineRow[];
    series: LineSeries[];
    legend: LineSeries[];
};

export function usageOf(
    report: TrafficReport,
    metric: TrafficMetric,
    colors: Map<number, string>,
    custom: boolean,
    subject: string,
): Usage {
    const keyOf = (version: number | null | undefined) =>
        !custom
            ? ALL
            : version !== null && version !== undefined && colors.has(version)
              ? `v${version}`
              : EARLIER;
    const groups = new Map<string, Map<number, TrafficStats[]>>();
    for (const point of report.points) {
        const key = keyOf(point.version);
        const byBucket = groups.get(key) ?? new Map<number, TrafficStats[]>();
        byBucket.set(point.bucket, [...(byBucket.get(point.bucket) ?? []), point]);
        groups.set(key, byBucket);
    }
    const live = report.versions.find((item) => item.live)?.version ?? null;
    const colored = [...colors.keys()].filter((number) => groups.has(`v${number}`));
    const series: LineSeries[] = custom
        ? [
              ...colored.map((number) => {
                  const buckets = groups.get(`v${number}`);
                  return {
                      key: `v${number}`,
                      label: number === live ? `v${number} live` : `v${number}`,
                      color: colors.get(number) ?? OTHER_COLOR,
                      dots: (buckets?.size ?? 0) < 3,
                  };
              }),
              ...(groups.has(EARLIER)
                  ? [{ key: EARLIER, label: "Other versions", color: OTHER_COLOR }]
                  : []),
          ].reverse()
        : groups.has(ALL)
          ? [
                {
                    key: ALL,
                    label: subject,
                    color: SERIES_COLORS[0],
                    dots: (groups.get(ALL)?.size ?? 0) < 3,
                },
            ]
          : [];
    const rows = report.buckets.map((_, index) => {
        const row: LineRow = { step: bucketEnd(report, index) };
        for (const item of series) {
            const found = groups.get(item.key)?.get(index);
            const empty = metric === "requests" || metric === "cost" ? 0 : null;
            row[item.key] = found ? metricValue(merged(found), metric) : empty;
        }
        return row;
    });
    return { rows, series, legend: [...series].reverse() };
}

const RANGE_MS: Record<TrafficRange, number> = {
    "24h": 86400000,
    "7d": 7 * 86400000,
    "30d": 30 * 86400000,
};

export function zeroUsage(
    report: TrafficReport | undefined,
    range: TrafficRange,
    label: string,
): Usage {
    const series: LineSeries[] = [{ key: "zero", label, color: SERIES_COLORS[0] }];
    const now = Date.now();
    const steps =
        report && report.buckets.length > 0
            ? report.buckets.map((_, index) => bucketEnd(report, index))
            : [now - RANGE_MS[range], now];
    return { rows: steps.map((step) => ({ step, zero: 0 })), series, legend: series };
}

export function percentileLines(report: TrafficReport): Usage {
    const series: LineSeries[] = [
        { key: "p99", label: "p99", color: LATENCY_COLORS.p99 },
        { key: "p95", label: "p95", color: LATENCY_COLORS.p95 },
        { key: "p50", label: "p50", color: LATENCY_COLORS.p50 },
    ];
    const rows = report.buckets.map((bucket, index) => {
        const has = bucket.requests > 0;
        return {
            step: bucketEnd(report, index),
            p50: has ? (bucket.p50_ms ?? null) : null,
            p95: has ? (bucket.p95_ms ?? null) : null,
            p99: has ? (bucket.p99_ms ?? null) : null,
        };
    });
    return { rows, series, legend: [...series].reverse() };
}

export function errorLine(report: TrafficReport): Usage {
    const series: LineSeries[] = [{ key: "errors", label: "Error rate", color: SERIES_COLORS[0] }];
    const rows = report.buckets.map((bucket, index) => ({
        step: bucketEnd(report, index),
        errors: bucket.requests > 0 ? bucket.errors / bucket.requests : null,
    }));
    return { rows, series, legend: series };
}

function signed(value: number, digits: number, unit: string): string {
    const shown = Math.abs(value).toFixed(digits);
    if (Number(shown) === 0) {
        return `±0${unit}`;
    }
    return `${value > 0 ? "+" : "−"}${shown}${unit}`;
}

export function relativeChange(now: number | null, before: number | null): string | null {
    if (now === null || before === null || before === 0) {
        return null;
    }
    return signed(((now - before) / before) * 100, 0, "%");
}

export function pointsChange(now: number | null, before: number | null): string | null {
    if (now === null || before === null) {
        return null;
    }
    return signed((now - before) * 100, 1, " pts");
}
