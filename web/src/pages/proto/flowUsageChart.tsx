import { SegmentedTabs } from "obp-ui";
import { type ReactNode, useState } from "react";
import {
    StepChart,
    type StepMarker,
    type StepRow,
    type StepSeries,
} from "~/components/charts/StepChart";
import { ChartLegend } from "~/components/charts/TimeChart";
import { count } from "~/lib/format";
import { HOUR_MS } from "./flowTraffic";
import type { Usage, UsageMetric, UsageRange } from "./flowUsage";

export const METRICS: { key: UsageMetric; label: string }[] = [
    { key: "requests", label: "Requests" },
    { key: "p95", label: "p95 latency" },
    { key: "errors", label: "Errors" },
    { key: "cost", label: "Cost" },
];

export const RANGES: { key: UsageRange; label: string }[] = [
    { key: "24h", label: "24h" },
    { key: "7d", label: "7d" },
    { key: "30d", label: "30d" },
];

export const SPAN: Record<UsageRange, string> = {
    "24h": "in the last 24 hours",
    "7d": "in the last 7 days",
    "30d": "in the last 30 days",
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

export function rate(value: number): string {
    return `${(value * 100).toFixed(1)}%`;
}

export function fineRate(value: number): string {
    return `${(value * 100).toFixed(value < 0.01 ? 2 : 1)}%`;
}

export function ms(value: number): string {
    return `${count(value)} ms`;
}

export function gpu(value: number): string {
    return `${value.toFixed(value < 10 ? 2 : 1)} GPU·s`;
}

export function formatOf(metric: UsageMetric): (value: number) => string {
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

function headline(metric: UsageMetric, usage: Usage): string {
    if (metric === "requests") {
        return `${count(usage.total)} requests`;
    }
    if (metric === "p95") {
        return `p95 ${ms(usage.p95)}`;
    }
    if (metric === "errors") {
        return `${rate(usage.errors)} errors`;
    }
    return `${usage.cost.toFixed(1)} GPU·s`;
}

function axisFormat(range: UsageRange): (value: number) => string {
    return (value) => (range === "24h" ? HOUR : DAY).format(new Date(value));
}

function readoutTitle(bucketHours: number): (value: number) => string {
    return (value) => {
        const start = new Date(value - bucketHours * HOUR_MS);
        return bucketHours >= 24
            ? WEEKDAY.format(start)
            : `${DAY_HOUR.format(start)} – ${HOUR.format(new Date(value))}`;
    };
}

function notesFor(
    events: StepMarker[],
    bucketHours: number,
): ((value: number) => string[]) | undefined {
    if (events.length === 0) {
        return undefined;
    }
    return (value) =>
        events
            .filter((item) => item.at <= value && item.at > value - bucketHours * HOUR_MS)
            .map((item) => item.label);
}

export function EmptyOverlay({ title, hint }: { title: string; hint?: string | null }) {
    return (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 pb-6 pl-14 text-center">
            <p className="bg-card px-2 font-medium">{title}</p>
            {hint && <p className="bg-card px-2 text-sm text-muted-foreground">{hint}</p>}
        </div>
    );
}

export function UsageChart({
    load,
    range,
    onRange,
    subject,
    by,
    height = 200,
    headline: showHeadline = true,
    empty = false,
    emptyHint,
}: {
    load: (metric: UsageMetric) => Usage;
    range: UsageRange;
    onRange?: (range: UsageRange) => void;
    subject: string;
    by: string | null;
    height?: number;
    headline?: boolean;
    empty?: boolean;
    emptyHint?: string | null;
}) {
    const [metric, setMetric] = useState<UsageMetric>("requests");
    const usage = load(metric);
    const label = METRICS.find((item) => item.key === metric)?.label ?? "";
    return (
        <div className="flex min-w-0 flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <SegmentedTabs
                    tabs={METRICS}
                    active={metric}
                    onSelect={(key) => setMetric(key as UsageMetric)}
                />
                {onRange && (
                    <SegmentedTabs
                        tabs={RANGES}
                        active={range}
                        onSelect={(key) => onRange(key as UsageRange)}
                    />
                )}
            </div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
                {showHeadline ? (
                    <p className="flex items-baseline gap-2">
                        <span className="text-xl tabular-nums">{headline(metric, usage)}</span>
                        <span className="text-sm text-muted-foreground">{SPAN[range]}</span>
                    </p>
                ) : (
                    <span />
                )}
                <ChartLegend series={usage.legend} />
            </div>
            <div className="relative">
                <StepChart
                    rows={usage.rows}
                    series={usage.series}
                    format={formatOf(metric)}
                    label={`${label} for ${subject} ${SPAN[range]}${by ? `, ${by}` : ""}`}
                    height={height}
                    markers={usage.markers}
                    connectNulls={false}
                    yDomain={empty ? [0, 100] : undefined}
                    xFormat={axisFormat(range)}
                    readoutTitle={readoutTitle(usage.bucketHours)}
                    readoutNotes={notesFor(usage.events, usage.bucketHours)}
                />
                {empty && <EmptyOverlay title="No requests yet" hint={emptyHint} />}
            </div>
        </div>
    );
}

export function LineChart({
    rows,
    series,
    range,
    bucketHours,
    format,
    label,
    height = 200,
    levels,
    legend = true,
    children,
}: {
    rows: StepRow[];
    series: StepSeries[];
    range: UsageRange;
    bucketHours: number;
    format: (value: number) => string;
    label: string;
    height?: number;
    levels?: StepMarker[];
    legend?: boolean;
    children?: ReactNode;
}) {
    return (
        <div className="flex min-w-0 flex-col gap-3">
            {(legend || children) && (
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
                    {children ?? <span />}
                    {legend && <ChartLegend series={series} />}
                </div>
            )}
            <StepChart
                rows={rows}
                series={series}
                format={format}
                label={label}
                height={height}
                levels={levels}
                connectNulls={false}
                xFormat={axisFormat(range)}
                readoutTitle={readoutTitle(bucketHours)}
            />
        </div>
    );
}
