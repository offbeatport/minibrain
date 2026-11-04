import { cn } from "obp-ui";
import type { ReactNode } from "react";
import {
    Area,
    AreaChart,
    Bar,
    BarChart,
    CartesianGrid,
    Line,
    LineChart,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";

export type ChartSeries = { key: string; label: string; color: string };
export type ChartRow = { at: number; [series: string]: number | null };
export type ChartKind = "stacked-area" | "lines" | "stacked-bars";

const HEIGHT = 180;
const AXIS_WIDTH = 60;
const TICK = { fill: "var(--muted-foreground)", fontSize: "var(--type-sm)" };
const GRID = "var(--border)";
const SURFACE = "var(--card)";
const BAR_MAX = 24;
const DAY_MS = 24 * 3600 * 1000;

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const DAY_CLOCK = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
});

const SHARE_STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5];

function shareTicks(rows: ChartRow[], series: ChartSeries[]): number[] {
    const values = rows.flatMap((row) => series.map((item) => row[item.key] ?? 0));
    const top = Math.min(1, Math.max(0.01, ...values));
    const step = SHARE_STEPS.find((candidate) => top / candidate <= 4) ?? 0.25;
    const count = Math.ceil(top / step - 1e-9);
    return Array.from({ length: count + 1 }, (_, index) => Math.min(1, index * step));
}

function tickTime(span: number) {
    return (value: number) => (span > 2 * DAY_MS ? DAY : CLOCK).format(new Date(value));
}

type ReadoutEntry = { dataKey?: unknown; value?: unknown };

function Readout({
    active,
    payload,
    label,
    series,
    format,
    bucketMs,
}: {
    active?: boolean;
    payload?: readonly ReadoutEntry[];
    label?: unknown;
    series: ChartSeries[];
    format: (value: number) => string;
    bucketMs: number;
}) {
    if (!active || !payload?.length || typeof label !== "number") {
        return null;
    }
    const values = new Map(payload.map((item) => [String(item.dataKey), item.value]));
    const end = new Date(label + bucketMs);
    return (
        <div className="min-w-44 rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-e2">
            <div className="pb-1.5 text-muted-foreground tabular-nums">
                {`${DAY_CLOCK.format(new Date(label))} – ${CLOCK.format(end)}`}
            </div>
            <ul className="flex flex-col gap-1">
                {[...series].reverse().map((item) => {
                    const value = values.get(item.key);
                    return (
                        <li key={item.key} className="flex items-center gap-2">
                            <span
                                aria-hidden="true"
                                className="h-0.5 w-3 shrink-0 rounded-full"
                                style={{ background: item.color }}
                            />
                            <span className="font-semibold tabular-nums">
                                {typeof value === "number" ? format(value) : "–"}
                            </span>
                            <span className="min-w-0 truncate text-muted-foreground">
                                {item.label}
                            </span>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

function marks(kind: ChartKind, series: ChartSeries[]): ReactNode[] {
    if (kind === "stacked-bars") {
        return series.map((item) => (
            <Bar
                key={item.key}
                dataKey={item.key}
                name={item.label}
                stackId="total"
                fill={item.color}
                maxBarSize={BAR_MAX}
                isAnimationActive={false}
            />
        ));
    }
    if (kind === "stacked-area") {
        return series.map((item) => (
            <Area
                key={item.key}
                dataKey={item.key}
                name={item.label}
                type="monotone"
                stackId="total"
                stroke={item.color}
                strokeWidth={2}
                fill={item.color}
                fillOpacity={0.12}
                activeDot={{ r: 4, stroke: SURFACE, strokeWidth: 2 }}
                isAnimationActive={false}
            />
        ));
    }
    return series.map((item) => (
        <Line
            key={item.key}
            dataKey={item.key}
            name={item.label}
            type="monotone"
            stroke={item.color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            dot={false}
            activeDot={{ r: 4, stroke: SURFACE, strokeWidth: 2 }}
            connectNulls={false}
            isAnimationActive={false}
        />
    ));
}

export function TimeChart({
    kind,
    rows,
    series,
    format,
    axisFormat,
    bucketMs,
    label,
    fractions = false,
    dimmed = false,
}: {
    kind: ChartKind;
    rows: ChartRow[];
    series: ChartSeries[];
    format: (value: number) => string;
    axisFormat?: (value: number) => string;
    bucketMs: number;
    label: string;
    fractions?: boolean;
    dimmed?: boolean;
}) {
    const first = rows[0]?.at ?? 0;
    const last = rows.at(-1)?.at ?? first;
    const span = last - first + bucketMs;
    const Chart =
        kind === "stacked-bars" ? BarChart : kind === "stacked-area" ? AreaChart : LineChart;
    const ticks = fractions ? shareTicks(rows, series) : undefined;
    return (
        <div
            role="img"
            aria-label={label}
            className={cn("w-full text-sm tabular-nums", dimmed && "opacity-60")}
            style={{ height: HEIGHT }}
        >
            <ResponsiveContainer width="100%" height="100%">
                <Chart data={rows} margin={{ top: 4, right: 36, bottom: 0, left: 0 }}>
                    <CartesianGrid vertical={false} stroke={GRID} strokeWidth={1} />
                    <XAxis
                        dataKey="at"
                        type="number"
                        scale="time"
                        domain={[first, last]}
                        tickFormatter={tickTime(span)}
                        tick={TICK}
                        tickLine={false}
                        axisLine={{ stroke: GRID }}
                        minTickGap={48}
                        padding={kind === "stacked-bars" ? { left: 8, right: 8 } : undefined}
                    />
                    <YAxis
                        width={AXIS_WIDTH}
                        tick={TICK}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={axisFormat ?? format}
                        allowDecimals={fractions}
                        ticks={ticks}
                        domain={ticks ? [0, ticks.at(-1) ?? 1] : [0, "auto"]}
                    />
                    <Tooltip
                        cursor={
                            kind === "stacked-bars"
                                ? { fill: "var(--secondary)" }
                                : { stroke: "var(--input)", strokeWidth: 1 }
                        }
                        isAnimationActive={false}
                        content={(props) => (
                            <Readout
                                active={props.active}
                                payload={props.payload}
                                label={props.label}
                                series={series}
                                format={format}
                                bucketMs={bucketMs}
                            />
                        )}
                    />
                    {marks(kind, series)}
                </Chart>
            </ResponsiveContainer>
        </div>
    );
}

export function ChartLegend({ series }: { series: ChartSeries[] }) {
    if (series.length < 2) {
        return null;
    }
    return (
        <ul className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm">
            {series.map((item) => (
                <li key={item.key} className="flex min-w-0 items-center gap-2">
                    <span
                        aria-hidden="true"
                        className="size-2.5 shrink-0 rounded-sm"
                        style={{ background: item.color }}
                    />
                    <span className="max-w-56 truncate">{item.label}</span>
                </li>
            ))}
        </ul>
    );
}
