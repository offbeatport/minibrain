import {
    CartesianGrid,
    Line,
    LineChart,
    ReferenceLine,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";

export type StepSeries = {
    key: string;
    label: string;
    color: string;
    dots?: boolean;
};
export type StepRow = { step: number; [series: string]: number | null };
export type StepMarker = { at: number; label: string };

const AXIS_WIDTH = 56;
const TICK = { fill: "var(--muted-foreground)", fontSize: "var(--type-sm)" };
const GRID = "var(--border)";
const SURFACE = "var(--card)";
const STEPS = new Intl.NumberFormat();

type ReadoutEntry = { dataKey?: unknown; value?: unknown };

function Readout({
    active,
    payload,
    label,
    series,
    format,
    title,
}: {
    active?: boolean;
    payload?: readonly ReadoutEntry[];
    label?: unknown;
    series: StepSeries[];
    format: (value: number) => string;
    title: (value: number) => string;
}) {
    if (!active || !payload?.length || typeof label !== "number") {
        return null;
    }
    const values = new Map(payload.map((item) => [String(item.dataKey), item.value]));
    const shown = [...series].reverse().filter((item) => typeof values.get(item.key) === "number");
    if (shown.length === 0) {
        return null;
    }
    return (
        <div className="min-w-40 rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-e2">
            <div className="pb-1.5 text-muted-foreground tabular-nums">{title(label)}</div>
            <ul className="flex flex-col gap-1">
                {shown.map((item) => (
                    <li key={item.key} className="flex items-center gap-2">
                        <span
                            aria-hidden="true"
                            className="h-0.5 w-3 shrink-0 rounded-full"
                            style={{ background: item.color }}
                        />
                        <span className="font-semibold tabular-nums">
                            {format(values.get(item.key) as number)}
                        </span>
                        <span className="min-w-0 truncate text-muted-foreground">{item.label}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

export function StepChart({
    rows,
    series,
    format,
    axisFormat,
    label,
    height = 220,
    marker,
    markers = [],
    domain,
    xFormat = (value: number) => STEPS.format(value),
    readoutTitle = (value: number) => `Step ${STEPS.format(value)}`,
    connectNulls = true,
}: {
    rows: StepRow[];
    series: StepSeries[];
    format: (value: number) => string;
    axisFormat?: (value: number) => string;
    label: string;
    height?: number;
    marker?: number | null;
    markers?: StepMarker[];
    domain?: [number, number];
    xFormat?: (value: number) => string;
    readoutTitle?: (value: number) => string;
    connectNulls?: boolean;
}) {
    const first = rows[0]?.step ?? 0;
    const last = rows.at(-1)?.step ?? first;
    return (
        <div
            role="img"
            aria-label={label}
            className="w-full text-sm tabular-nums"
            style={{ height }}
        >
            <ResponsiveContainer width="100%" height="100%">
                <LineChart
                    data={rows}
                    margin={{ top: markers.length > 0 ? 24 : 8, right: 16, bottom: 0, left: 0 }}
                >
                    <CartesianGrid vertical={false} stroke={GRID} strokeWidth={1} />
                    <XAxis
                        dataKey="step"
                        type="number"
                        domain={domain ?? [first, last]}
                        tickFormatter={xFormat}
                        tick={TICK}
                        tickLine={false}
                        axisLine={{ stroke: GRID }}
                        minTickGap={40}
                        allowDecimals={false}
                    />
                    <YAxis
                        width={AXIS_WIDTH}
                        tick={TICK}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={axisFormat ?? format}
                        domain={["auto", "auto"]}
                    />
                    <Tooltip
                        cursor={{ stroke: "var(--input)", strokeWidth: 1 }}
                        isAnimationActive={false}
                        content={(props) => (
                            <Readout
                                active={props.active}
                                payload={props.payload}
                                label={props.label}
                                series={series}
                                format={format}
                                title={readoutTitle}
                            />
                        )}
                    />
                    {marker !== null && marker !== undefined && (
                        <ReferenceLine
                            x={marker}
                            stroke="var(--warning)"
                            strokeWidth={1}
                            ifOverflow="extendDomain"
                        />
                    )}
                    {markers.map((item) => (
                        <ReferenceLine
                            key={`${item.at}-${item.label}`}
                            x={item.at}
                            stroke="var(--faint)"
                            strokeDasharray="3 3"
                            strokeWidth={1}
                            label={{
                                value: item.label,
                                position: "top",
                                fill: "var(--muted-foreground)",
                                fontSize: "var(--type-sm)",
                            }}
                        />
                    ))}
                    {series.map((item) => (
                        <Line
                            key={item.key}
                            dataKey={item.key}
                            name={item.label}
                            type="linear"
                            stroke={item.color}
                            strokeWidth={2}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            dot={
                                item.dots
                                    ? { r: 3, strokeWidth: 2, stroke: SURFACE, fill: item.color }
                                    : false
                            }
                            activeDot={{ r: 4, stroke: SURFACE, strokeWidth: 2 }}
                            connectNulls={connectNulls}
                            isAnimationActive={false}
                        />
                    ))}
                </LineChart>
            </ResponsiveContainer>
        </div>
    );
}
