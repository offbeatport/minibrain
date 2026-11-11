import type { StepMarker, StepRow, StepSeries } from "~/components/charts/StepChart";
import type { FlowModel } from "./modelsFlowData";

export type UsageRange = "24h" | "7d" | "30d";
export type UsageMetric = "requests" | "p95" | "errors" | "cost";

export type Pointer = {
    hoursAgo: number;
    version: number;
    canary?: { version: number; share: number };
};

const DAY = 24;
const HOUR_MS = 3600 * 1000;
const RANGE_HOURS: Record<UsageRange, number> = { "24h": 24, "7d": 7 * DAY, "30d": 30 * DAY };
const BUCKET_HOURS: Record<UsageRange, number> = { "24h": 1, "7d": 6, "30d": DAY };
const SLOTS = [
    "var(--flow-series-1)",
    "var(--flow-series-2)",
    "var(--flow-series-3)",
    "var(--flow-series-4)",
];
const EARLIER = "earlier";
const EARLIER_COLOR = "var(--faint)";

const HISTORY: Record<string, Pointer[]> = {
    "support-triage": [
        { hoursAgo: 33 * DAY, version: 1 },
        { hoursAgo: 29.5 * DAY, version: 2 },
        { hoursAgo: 25.5 * DAY, version: 3 },
        { hoursAgo: 20.6 * DAY, version: 4 },
    ],
    "invoice-extractor": [
        { hoursAgo: 9 * DAY, version: 1 },
        { hoursAgo: 3.6 * DAY, version: 2 },
        { hoursAgo: 20, version: 2, canary: { version: 3, share: 10 } },
    ],
    "contract-reviewer": [{ hoursAgo: 15 * DAY, version: 1 }],
    guy1: [{ hoursAgo: 3 * DAY, version: 0 }],
};

const HOUR_SHAPE = [
    0.2, 0.15, 0.12, 0.1, 0.12, 0.2, 0.4, 0.7, 1.1, 1.4, 1.5, 1.45, 1.3, 1.4, 1.5, 1.45, 1.3, 1.1,
    0.9, 0.7, 0.55, 0.45, 0.35, 0.25,
];
const SHAPE_TOTAL = HOUR_SHAPE.reduce((sum, value) => sum + value, 0);

function noise(seed: number): number {
    const value = Math.sin(seed * 12.9898) * 43758.5453;
    return value - Math.floor(value);
}

function sameCanary(pointer: Pointer, model: FlowModel): boolean {
    return (
        (pointer.canary?.version ?? null) === (model.canary?.version ?? null) &&
        (pointer.canary?.share ?? null) === (model.canary?.share ?? null)
    );
}

export function pointersOf(model: FlowModel): Pointer[] {
    if (model.kind === "base") {
        return model.deployed ? [{ hoursAgo: 40 * DAY, version: 0 }] : [];
    }
    if (model.live === null) {
        return HISTORY[model.slug] ?? [];
    }
    const live = model.versions.find((version) => version.number === model.live);
    const known = HISTORY[model.slug] ?? [
        { hoursAgo: Math.min(live?.hoursAgo ?? 0, 40 * DAY), version: model.live },
    ];
    const last = known.at(-1);
    if (last && last.version === model.live && sameCanary(last, model)) {
        return known;
    }
    return [
        ...known,
        {
            hoursAgo: 0,
            version: model.live,
            canary: model.canary ? { ...model.canary } : undefined,
        },
    ];
}

function activeAt(pointers: Pointer[], hoursAgo: number): Pointer | undefined {
    return [...pointers].reverse().find((pointer) => pointer.hoursAgo > hoursAgo);
}

function dailyTotal(model: FlowModel, dayAgo: number): number {
    if (dayAgo < 7) {
        return model.traffic[6 - dayAgo] ?? 0;
    }
    const mean = model.traffic.reduce((sum, value) => sum + value, 0) / 7;
    const weekday = model.traffic[6 - (dayAgo % 7)] ?? mean;
    return Math.round((weekday * 0.6 + mean * 0.4) * (0.82 + noise(dayAgo + 7) * 0.3));
}

type HourCell = { version: number; requests: number; p95: number; errors: number };

function versionLatency(model: FlowModel, version: number, hour: number): number {
    const drift = 1 + (((version * 37) % 11) - 5) / 60;
    const spike = model.slug === "invoice-extractor" && version === 3 ? 2.6 : 1;
    return Math.round(model.p95 * drift * spike * (0.88 + noise(hour * 3 + version) * 0.24));
}

function versionErrors(model: FlowModel, version: number, hour: number): number {
    const spike = model.slug === "invoice-extractor" && version === 3 ? 0.21 : model.usualErrors;
    return Math.max(0, spike * (0.6 + noise(hour * 5 + version) * 0.8));
}

function hourCells(model: FlowModel, pointers: Pointer[], hoursAgo: number): HourCell[] {
    const pointer = activeAt(pointers, hoursAgo);
    if (!pointer) {
        return [];
    }
    const now = new Date();
    const clock = (now.getHours() - hoursAgo + 24 * 60) % 24;
    const total = (dailyTotal(model, Math.floor(hoursAgo / DAY)) * HOUR_SHAPE[clock]) / SHAPE_TOTAL;
    const shares: [number, number][] = pointer.canary
        ? [
              [pointer.version, 1 - pointer.canary.share / 100],
              [pointer.canary.version, pointer.canary.share / 100],
          ]
        : [[pointer.version, 1]];
    return shares.map(([version, share]) => ({
        version,
        requests: total * share,
        p95: versionLatency(model, version, hoursAgo),
        errors: versionErrors(model, version, hoursAgo),
    }));
}

export type UsageSeries = StepSeries & { version: number | null };

export type Usage = {
    rows: StepRow[];
    series: UsageSeries[];
    markers: StepMarker[];
    total: number;
    p95: number;
    errors: number;
    cost: number;
    bucketHours: number;
};

function slotted(model: FlowModel, pointers: Pointer[]): number[] {
    const served = new Set<number>();
    for (let hour = 0; hour < RANGE_HOURS["30d"]; hour += 1) {
        for (const cell of hourCells(model, pointers, hour)) {
            if (cell.requests > 0) {
                served.add(cell.version);
            }
        }
    }
    return [...served].sort((a, b) => b - a).slice(0, SLOTS.length);
}

type Bucket = { requests: number; latency: number; failed: number };

function metricValue(bucket: Bucket, metric: UsageMetric, gpuSeconds: number): number | null {
    if (bucket.requests <= 0) {
        return null;
    }
    if (metric === "requests") {
        return Math.round(bucket.requests);
    }
    if (metric === "p95") {
        return Math.round(bucket.latency / bucket.requests);
    }
    if (metric === "errors") {
        return bucket.failed / bucket.requests;
    }
    return (bucket.requests / 1000) * gpuSeconds;
}

export function usageOf(model: FlowModel, range: UsageRange, metric: UsageMetric): Usage {
    const pointers = pointersOf(model);
    const colored = slotted(model, pointers);
    const keyOf = (version: number) => (colored.includes(version) ? `v${version}` : EARLIER);
    const bucketHours = BUCKET_HOURS[range];
    const count = RANGE_HOURS[range] / bucketHours;
    const now = Date.now();
    const keys = new Set<string>();
    let total = 0;
    let latency = 0;
    let failed = 0;
    const rows: StepRow[] = [];
    for (let index = count - 1; index >= 0; index -= 1) {
        const buckets = new Map<string, Bucket>();
        for (let offset = 0; offset < bucketHours; offset += 1) {
            const hoursAgo = index * bucketHours + offset;
            for (const cell of hourCells(model, pointers, hoursAgo)) {
                const key = keyOf(cell.version);
                const bucket = buckets.get(key) ?? { requests: 0, latency: 0, failed: 0 };
                bucket.requests += cell.requests;
                bucket.latency += cell.p95 * cell.requests;
                bucket.failed += cell.errors * cell.requests;
                buckets.set(key, bucket);
                total += cell.requests;
                latency += cell.p95 * cell.requests;
                failed += cell.errors * cell.requests;
            }
        }
        const row: StepRow = { step: now - index * bucketHours * HOUR_MS };
        for (const [key, bucket] of buckets) {
            const value = metricValue(bucket, metric, model.gpuSeconds);
            if (value !== null) {
                keys.add(key);
                row[key] = value;
            }
        }
        rows.push(row);
    }
    const series: UsageSeries[] = [
        ...colored
            .filter((version) => keys.has(`v${version}`))
            .map((version) => ({
                key: `v${version}`,
                label:
                    model.kind === "base"
                        ? "Deployed variants"
                        : model.live === version
                          ? `v${version} live`
                          : `v${version}`,
                color: SLOTS[colored.indexOf(version)],
                dots: rows.filter((row) => typeof row[`v${version}`] === "number").length < 3,
                version,
            })),
        ...(keys.has(EARLIER)
            ? [{ key: EARLIER, label: "Earlier", color: EARLIER_COLOR, version: null }]
            : []),
    ].reverse();
    for (const row of rows) {
        for (const item of series) {
            if (!(item.key in row)) {
                row[item.key] = null;
            }
        }
    }
    const start = now - RANGE_HOURS[range] * HOUR_MS;
    const markers: StepMarker[] = pointers
        .map((pointer, position) => ({
            at: Math.min(now, now - pointer.hoursAgo * HOUR_MS),
            label: pointer.canary
                ? `v${pointer.canary.version} canary ${pointer.canary.share}%`
                : `v${pointer.version} made live`,
            first: position === 0,
        }))
        .filter((item) => item.at > start + bucketHours * HOUR_MS && !item.first)
        .map(({ at, label }) => ({ at, label }));
    return {
        rows,
        series,
        markers,
        total: Math.round(total),
        p95: total > 0 ? Math.round(latency / total) : 0,
        errors: total > 0 ? failed / total : 0,
        cost: (total / 1000) * model.gpuSeconds,
        bucketHours,
    };
}
