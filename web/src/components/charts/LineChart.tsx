import type { ReactNode } from "react";
import { StepChart, type StepMarker, type StepRow, type StepSeries } from "./StepChart";
import { ChartLegend } from "./TimeChart";

export type { StepMarker as LineMarker, StepRow as LineRow, StepSeries as LineSeries };

export const SERIES_COLORS = [
    "var(--chart-series-1)",
    "var(--chart-series-2)",
    "var(--chart-series-3)",
    "var(--chart-series-4)",
];

export const OTHER_COLOR = "var(--faint)";

export const LATENCY_COLORS = {
    p50: "var(--chart-latency-1)",
    p95: "var(--chart-latency-2)",
    p99: "var(--chart-latency-3)",
};

export function EmptyOverlay({ title, hint }: { title: string; hint?: ReactNode }) {
    return (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 pb-6 pl-14 text-center">
            <p className="bg-card px-2 font-medium">{title}</p>
            {hint && <p className="bg-card px-2 text-base text-muted-foreground">{hint}</p>}
        </div>
    );
}

export function LineChart({
    rows,
    series,
    format,
    axisFormat,
    label,
    height = 200,
    markers,
    levels,
    domain,
    yDomain,
    xFormat,
    readoutTitle,
    readoutNotes,
    legend = true,
    legendSeries,
    header,
    empty,
}: {
    rows: StepRow[];
    series: StepSeries[];
    format: (value: number) => string;
    axisFormat?: (value: number) => string;
    label: string;
    height?: number;
    markers?: StepMarker[];
    levels?: StepMarker[];
    domain?: [number, number];
    yDomain?: [number, number];
    xFormat?: (value: number) => string;
    readoutTitle?: (value: number) => string;
    readoutNotes?: (value: number) => string[];
    legend?: boolean;
    legendSeries?: StepSeries[];
    header?: ReactNode;
    empty?: { title: string; hint?: ReactNode } | null;
}) {
    const shown = legendSeries ?? series;
    return (
        <div className="flex min-w-0 flex-col gap-3">
            {(header || (legend && shown.length > 1)) && (
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
                    {header ?? <span />}
                    {legend && <ChartLegend series={shown} />}
                </div>
            )}
            <div className="relative">
                <StepChart
                    rows={rows}
                    series={empty ? [] : series}
                    format={format}
                    axisFormat={axisFormat}
                    label={label}
                    height={height}
                    markers={empty ? [] : markers}
                    levels={levels}
                    domain={domain}
                    yDomain={empty ? [0, 100] : yDomain}
                    xFormat={xFormat}
                    readoutTitle={readoutTitle}
                    readoutNotes={readoutNotes}
                    connectNulls={false}
                />
                {empty && <EmptyOverlay title={empty.title} hint={empty.hint} />}
            </div>
        </div>
    );
}
