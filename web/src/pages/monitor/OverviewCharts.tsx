import { SegmentedTabs } from "obp-ui";
import { useState } from "react";
import type { RequestOverview } from "~/api/requestQueries";
import { Section } from "~/components/Section";
import {
    ChartLegend,
    type ChartRow,
    type ChartSeries,
    TimeChart,
} from "~/components/charts/TimeChart";
import { count, milliseconds, percent } from "~/lib/format";

const COMPACT = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

type Point = RequestOverview["points"][number];
type Latency = "p95" | "p50";
type TokenSide = "in" | "out";

function pivot(
    overview: RequestOverview | undefined,
    series: ChartSeries[],
    value: (point: Point, seconds: number) => number | null,
    empty: number | null,
): ChartRow[] {
    if (!overview) {
        return [];
    }
    const rows = overview.buckets.map((bucket) => {
        const row: ChartRow = { at: Date.parse(bucket.at) };
        for (const item of series) {
            row[item.key] = empty;
        }
        return row;
    });
    for (const point of overview.points) {
        const key = series[point.series]?.key;
        const bucket = overview.buckets[point.bucket];
        if (key !== undefined && bucket) {
            rows[point.bucket][key] = value(point, bucket.seconds);
        }
    }
    return rows;
}

function perMinute(value: number): string {
    return `${value < 10 ? value.toFixed(1) : COMPACT.format(value)}/min`;
}

function latencyAxis(value: number): string {
    return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
}

function bucketLabel(seconds: number): string {
    if (seconds < 60) {
        return `${seconds}-second`;
    }
    if (seconds < 3600) {
        return `${seconds / 60}-minute`;
    }
    return seconds < 86400 ? `${seconds / 3600}-hour` : `${seconds / 86400}-day`;
}

function share(value: number): string {
    return `${Math.round(value * 100)}%`;
}

function Toggle<T extends string>({
    value,
    options,
    onChange,
}: {
    value: T;
    options: { key: T; label: string }[];
    onChange: (value: T) => void;
}) {
    return <SegmentedTabs tabs={options} active={value} onSelect={(next) => onChange(next as T)} />;
}

export default function OverviewCharts({
    overview,
    series,
    dimmed,
}: {
    overview: RequestOverview;
    series: ChartSeries[];
    dimmed: boolean;
}) {
    const [latency, setLatency] = useState<Latency>("p95");
    const [side, setSide] = useState<TokenSide>("in");
    const bucketMs = overview.bucket_seconds * 1000;
    const rates = pivot(overview, series, (point, seconds) => point.requests / (seconds / 60), 0);
    const errors = pivot(
        overview,
        series,
        (point) => (point.requests ? point.errors / point.requests : null),
        null,
    );
    const latencies = pivot(
        overview,
        series,
        (point) => (latency === "p95" ? point.p95_ms : point.p50_ms) ?? null,
        null,
    );
    const tokens = pivot(
        overview,
        series,
        (point) => (side === "in" ? point.prompt_tokens : point.completion_tokens),
        0,
    );
    const bucket = bucketLabel(overview.bucket_seconds);
    return (
        <>
            <ChartLegend series={series} />
            <div className="grid grid-cols-1 gap-panel-gap xl:grid-cols-2">
                <Section
                    title="Requests per minute"
                    caption={`Stacked by model, averaged over ${bucket} buckets.`}
                >
                    <TimeChart
                        kind="stacked-area"
                        rows={rates}
                        series={series}
                        format={perMinute}
                        axisFormat={(value) => COMPACT.format(value)}
                        bucketMs={bucketMs}
                        label="Requests per minute by model"
                        dimmed={dimmed}
                    />
                </Section>
                <Section title="Error rate" caption="Share of requests that ended in a 4xx or 5xx.">
                    <TimeChart
                        kind="lines"
                        rows={errors}
                        series={series}
                        format={percent}
                        axisFormat={share}
                        bucketMs={bucketMs}
                        label="Error rate by model"
                        fractions
                        dimmed={dimmed}
                    />
                </Section>
                <Section
                    title="Latency"
                    caption="Time to answer, as measured by the gateway."
                    actions={
                        <Toggle
                            value={latency}
                            options={[
                                { key: "p95", label: "p95" },
                                { key: "p50", label: "p50" },
                            ]}
                            onChange={setLatency}
                        />
                    }
                >
                    <TimeChart
                        kind="lines"
                        rows={latencies}
                        series={series}
                        format={milliseconds}
                        axisFormat={latencyAxis}
                        bucketMs={bucketMs}
                        label={`Latency ${latency} by model`}
                        dimmed={dimmed}
                    />
                </Section>
                <Section
                    title="Tokens"
                    caption="Tokens per bucket, stacked by model."
                    actions={
                        <Toggle
                            value={side}
                            options={[
                                { key: "in", label: "In" },
                                { key: "out", label: "Out" },
                            ]}
                            onChange={setSide}
                        />
                    }
                >
                    <TimeChart
                        kind="stacked-bars"
                        rows={tokens}
                        series={series}
                        format={count}
                        axisFormat={(value) => COMPACT.format(value)}
                        bucketMs={bucketMs}
                        label={`Tokens ${side} by model`}
                        dimmed={dimmed}
                    />
                </Section>
            </div>
        </>
    );
}
