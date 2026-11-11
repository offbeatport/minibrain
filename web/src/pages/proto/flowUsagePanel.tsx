import { SegmentedTabs } from "obp-ui";
import { useState } from "react";
import { StepChart } from "~/components/charts/StepChart";
import { ChartLegend } from "~/components/charts/TimeChart";
import { count } from "~/lib/format";
import { StatusLine } from "./flowStatusLine";
import { type UsageMetric, type UsageRange, usageOf } from "./flowUsage";
import type { FlowModel } from "./modelsFlowData";

const METRICS: { key: UsageMetric; label: string }[] = [
    { key: "requests", label: "Requests" },
    { key: "p95", label: "p95 latency" },
    { key: "errors", label: "Errors" },
    { key: "cost", label: "Cost" },
];

const RANGES: { key: UsageRange; label: string }[] = [
    { key: "24h", label: "24h" },
    { key: "7d", label: "7d" },
    { key: "30d", label: "30d" },
];

const SPAN: Record<UsageRange, string> = {
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

function formatOf(metric: UsageMetric): (value: number) => string {
    if (metric === "requests") {
        return (value) => count(value);
    }
    if (metric === "p95") {
        return (value) => `${count(value)} ms`;
    }
    if (metric === "errors") {
        return (value) => `${(value * 100).toFixed(value < 0.01 ? 2 : 1)}%`;
    }
    return (value) => `${value.toFixed(value < 10 ? 2 : 1)} GPU·s`;
}

function headline(metric: UsageMetric, usage: ReturnType<typeof usageOf>): string {
    if (metric === "requests") {
        return `${count(usage.total)} requests`;
    }
    if (metric === "p95") {
        return `p95 ${count(usage.p95)} ms`;
    }
    if (metric === "errors") {
        return `${(usage.errors * 100).toFixed(1)}% errors`;
    }
    return `${usage.cost.toFixed(1)} GPU·s`;
}

export function UsagePanel({ model }: { model: FlowModel }) {
    const [metric, setMetric] = useState<UsageMetric>("requests");
    const [range, setRange] = useState<UsageRange>("30d");
    const usage = usageOf(model, range, metric);
    const empty = usageOf(model, "30d", "requests").total === 0;
    const format = formatOf(metric);
    const daily = usage.bucketHours >= 24;
    const replicas = model.replicas.length;
    return (
        <section
            aria-label={`${model.name} usage`}
            className="flex min-w-0 flex-col gap-4 rounded-lg border bg-card p-panel"
        >
            <StatusLine model={model} />
            <div className="flex flex-wrap items-center justify-between gap-2">
                <SegmentedTabs
                    tabs={METRICS}
                    active={metric}
                    onSelect={(key) => setMetric(key as UsageMetric)}
                />
                <SegmentedTabs
                    tabs={RANGES}
                    active={range}
                    onSelect={(key) => setRange(key as UsageRange)}
                />
            </div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
                <p className="flex items-baseline gap-2">
                    <span className="text-xl tabular-nums">{headline(metric, usage)}</span>
                    <span className="text-sm text-muted-foreground">{SPAN[range]}</span>
                </p>
                <ChartLegend series={usage.series} />
            </div>
            <div className="relative">
                <StepChart
                    rows={usage.rows}
                    series={usage.series}
                    format={format}
                    label={`${METRICS.find((item) => item.key === metric)?.label} for ${model.name} ${SPAN[range]}${model.kind === "base" ? "" : ", by version"}`}
                    height={200}
                    markers={usage.markers}
                    connectNulls={false}
                    yDomain={empty ? [0, 100] : undefined}
                    xFormat={(value) => (range === "24h" ? HOUR : DAY).format(new Date(value))}
                    readoutTitle={(value) =>
                        daily
                            ? WEEKDAY.format(new Date(value - usage.bucketHours * 3600 * 1000))
                            : `${DAY_HOUR.format(new Date(value - usage.bucketHours * 3600 * 1000))} – ${HOUR.format(new Date(value))}`
                    }
                />
                {empty && (
                    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 pb-6 pl-14 text-center">
                        <p className="bg-card px-2 font-medium">No requests yet</p>
                        {!model.deployed && (
                            <p className="bg-card px-2 text-sm text-muted-foreground">
                                Deploy to start receiving requests
                            </p>
                        )}
                    </div>
                )}
            </div>
            <p className="text-sm text-muted-foreground tabular-nums">
                {`${empty ? "No traffic" : `p95 ${count(usage.p95)} ms · ${(usage.errors * 100).toFixed(1)}% errors`} · ${replicas} ${replicas === 1 ? "replica" : "replicas"}${replicas > 0 ? ` on ${model.replicas.join(", ")}` : ""}`}
            </p>
        </section>
    );
}
