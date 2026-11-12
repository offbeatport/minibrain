import { useSyncExternalStore } from "react";
import type { StepMarker, StepRow, StepSeries } from "~/components/charts/StepChart";
import {
    type Acc,
    BUCKET_HOURS,
    type Bucket,
    HOUR_MS,
    RANGE_HOURS,
    type Source,
    type UsageRange,
    bucketsOf,
    groupsOf,
    pointersOf,
    summaryOf,
} from "./flowTraffic";
import type { ApiKey, FlowModel } from "./modelsFlowData";

export { pointersOf };
export type { Pointer, UsageRange } from "./flowTraffic";

export type UsageMetric = "requests" | "p95" | "errors" | "cost";

export type UsageSeries = StepSeries & { version: number | null };

export type Usage = {
    rows: StepRow[];
    series: UsageSeries[];
    legend: UsageSeries[];
    markers: StepMarker[];
    events: StepMarker[];
    total: number;
    p95: number;
    errors: number;
    cost: number;
    bucketHours: number;
};

export type Lines = { rows: StepRow[]; series: StepSeries[]; bucketHours: number };

export const SLOTS = [
    "var(--flow-series-1)",
    "var(--flow-series-2)",
    "var(--flow-series-3)",
    "var(--flow-series-4)",
];
export const OTHER_COLOR = "var(--faint)";
const EARLIER = "earlier";
const OTHER = "other";

let sharedRange: UsageRange = "30d";
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function setUsageRange(range: UsageRange) {
    sharedRange = range;
    for (const listener of listeners) {
        listener();
    }
}

export function useUsageRange(): [UsageRange, (range: UsageRange) => void] {
    const range = useSyncExternalStore(subscribe, () => sharedRange);
    return [range, setUsageRange];
}

function metricValue(acc: Acc, metric: UsageMetric): number | null {
    if (acc.requests <= 0) {
        return null;
    }
    if (metric === "requests") {
        return Math.round(acc.requests);
    }
    if (metric === "p95") {
        return Math.round(acc.p95 / acc.requests);
    }
    if (metric === "errors") {
        return acc.failed / acc.requests;
    }
    return acc.cost;
}

function rowsOf(buckets: Bucket[], keys: string[], value: (acc: Acc) => number | null): StepRow[] {
    return buckets.map((bucket) => {
        const row: StepRow = { step: bucket.step };
        for (const key of keys) {
            const acc = bucket.groups.get(key);
            row[key] = acc ? value(acc) : null;
        }
        return row;
    });
}

function slotted(model: FlowModel, keys: ApiKey[]): number[] {
    const served = groupsOf([{ model, keys }], "30d", (_, cell) => String(cell.version));
    return [...served.entries()]
        .filter(([, acc]) => acc.requests > 0)
        .map(([version]) => Number(version))
        .sort((a, b) => b - a)
        .slice(0, SLOTS.length);
}

function markersOf(model: FlowModel, range: UsageRange): StepMarker[] {
    const now = Date.now();
    const start = now - RANGE_HOURS[range] * HOUR_MS;
    return pointersOf(model)
        .map((pointer, position) => ({
            at: Math.min(now, now - pointer.hoursAgo * HOUR_MS),
            label: pointer.canary
                ? `v${pointer.canary.version} canary ${pointer.canary.share}%`
                : `v${pointer.version} deployed`,
            first: position === 0,
        }))
        .filter((item) => item.at > start + BUCKET_HOURS[range] * HOUR_MS && !item.first)
        .map(({ at, label }) => ({ at, label }));
}

export function eventsOf(models: FlowModel[], range: UsageRange): StepMarker[] {
    const now = Date.now();
    const start = now - RANGE_HOURS[range] * HOUR_MS;
    return models
        .flatMap((model) =>
            pointersOf(model).map((pointer, position) => ({
                at: Math.min(now, now - pointer.hoursAgo * HOUR_MS),
                label:
                    model.kind === "base"
                        ? `${model.name} deployed`
                        : pointer.canary
                          ? `${model.name} v${pointer.canary.version} canary at ${pointer.canary.share}%`
                          : position === 0
                            ? `${model.name} deployed with v${pointer.version}`
                            : `${model.name} v${pointer.version} deployed`,
            })),
        )
        .filter((item) => item.at > start)
        .sort((a, b) => a.at - b.at);
}

function finish(
    sources: Source[],
    range: UsageRange,
    rows: StepRow[],
    series: UsageSeries[],
    markers: StepMarker[],
    events: StepMarker[],
    legend: UsageSeries[] = series,
): Usage {
    const totals = summaryOf(sources, range);
    return {
        rows,
        series,
        legend,
        markers,
        events,
        total: totals.requests,
        p95: Math.round(totals.p95),
        errors: totals.errors,
        cost: totals.cost,
        bucketHours: BUCKET_HOURS[range],
    };
}

export function usageOf(
    model: FlowModel,
    range: UsageRange,
    metric: UsageMetric,
    keys: ApiKey[] = [],
): Usage {
    const source: Source = { model, keys };
    const colored = slotted(model, keys);
    const keyOf = (version: number) => (colored.includes(version) ? `v${version}` : EARLIER);
    const buckets = bucketsOf([source], range, (_, cell) => keyOf(cell.version));
    const present = new Set(buckets.flatMap((bucket) => [...bucket.groups.keys()]));
    const rowsFor = (keys: string[]) => rowsOf(buckets, keys, (acc) => metricValue(acc, metric));
    const series: UsageSeries[] = [
        ...colored
            .filter((version) => present.has(`v${version}`))
            .map((version) => ({
                key: `v${version}`,
                label:
                    model.kind === "base"
                        ? "Deployed variants"
                        : model.live === version
                          ? `v${version} deployed`
                          : `v${version}`,
                color: SLOTS[colored.indexOf(version)],
                dots: buckets.filter((bucket) => bucket.groups.has(`v${version}`)).length < 3,
                version,
            })),
        ...(present.has(EARLIER)
            ? [{ key: EARLIER, label: "Earlier", color: OTHER_COLOR, version: null }]
            : []),
    ].reverse();
    const rows = rowsFor(series.map((item) => item.key));
    return finish([source], range, rows, series, markersOf(model, range), []);
}

export type FleetColor = { slug: string; color: string };

export function fleetColors(models: FlowModel[], keysOf: (slug: string) => ApiKey[]): FleetColor[] {
    return models
        .filter((model) => model.deployed)
        .map((model) => ({
            model,
            requests: summaryOf([{ model, keys: keysOf(model.slug) }], "30d").requests,
        }))
        .sort((a, b) => b.requests - a.requests)
        .map(({ model }, index) => ({
            slug: model.slug,
            color: SLOTS[index] ?? OTHER_COLOR,
        }));
}

export function fleetUsageOf(
    sources: Source[],
    range: UsageRange,
    metric: UsageMetric,
    colors: FleetColor[],
): Usage {
    const slotOf = (slug: string) => colors.findIndex((item) => item.slug === slug);
    const own = (slug: string) => {
        const slot = slotOf(slug);
        return (slot >= 0 && slot < SLOTS.length) || sources.length === 1;
    };
    const keyOf = (source: Source) => (own(source.model.slug) ? source.model.slug : OTHER);
    const buckets = bucketsOf(sources, range, (source) => keyOf(source));
    const present = new Set(buckets.flatMap((bucket) => [...bucket.groups.keys()]));
    const ordered = [...sources].sort((a, b) => slotOf(a.model.slug) - slotOf(b.model.slug));
    const folded = ordered.filter((source) => !own(source.model.slug));
    const series: UsageSeries[] = [
        ...ordered
            .filter((source) => own(source.model.slug) && present.has(source.model.slug))
            .map((source) => ({
                key: source.model.slug,
                label: source.model.name,
                color: colors[slotOf(source.model.slug)]?.color ?? OTHER_COLOR,
                version: null,
            })),
        ...(present.has(OTHER)
            ? [
                  {
                      key: OTHER,
                      label: `${folded.length} other${folded.length === 1 ? "" : "s"}`,
                      color: OTHER_COLOR,
                      version: null,
                  },
              ]
            : []),
    ].reverse();
    const rows = rowsOf(
        buckets,
        series.map((item) => item.key),
        (acc) => metricValue(acc, metric),
    );
    return finish(
        sources,
        range,
        rows,
        series,
        [],
        eventsOf(
            sources.map((source) => source.model),
            range,
        ),
        [...series].reverse(),
    );
}

const PERCENTILES: StepSeries[] = [
    { key: "p99", label: "p99", color: "var(--flow-latency-3)" },
    { key: "p95", label: "p95", color: "var(--flow-latency-2)" },
    { key: "p50", label: "p50", color: "var(--flow-latency-1)" },
];

export function latencyOf(sources: Source[], range: UsageRange): Lines {
    const buckets = bucketsOf(sources, range, () => "all");
    return {
        rows: buckets.map((bucket) => {
            const acc = bucket.groups.get("all");
            const has = acc && acc.requests > 0;
            return {
                step: bucket.step,
                p50: has ? Math.round(acc.p50 / acc.requests) : null,
                p95: has ? Math.round(acc.p95 / acc.requests) : null,
                p99: has ? Math.round(acc.p99 / acc.requests) : null,
            };
        }),
        series: PERCENTILES,
        bucketHours: BUCKET_HOURS[range],
    };
}

export function errorRateOf(sources: Source[], range: UsageRange): Lines {
    const buckets = bucketsOf(sources, range, () => "all");
    return {
        rows: buckets.map((bucket) => {
            const acc = bucket.groups.get("all");
            return {
                step: bucket.step,
                errors: acc && acc.requests > 0 ? acc.failed / acc.requests : null,
            };
        }),
        series: [{ key: "errors", label: "Error rate", color: "var(--foreground)" }],
        bucketHours: BUCKET_HOURS[range],
    };
}
