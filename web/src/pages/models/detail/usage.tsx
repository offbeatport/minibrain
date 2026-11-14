import { ChartLine } from "lucide-react";
import {
    CheckboxSelect,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "obp-ui";
import { useState, useSyncExternalStore } from "react";
import type { ModelRow, VersionInfo } from "~/api/client";
import { useModelTraffic } from "~/api/modelPageQueries";
import { PoolPlaces } from "~/components/PoolLink";
import { ErrorLine, PanelSection } from "~/components/Section";
import { LineChart } from "~/components/charts/LineChart";
import { ChartLegend } from "~/components/charts/TimeChart";
import {
    EMPTY_DOMAIN,
    METRICS,
    RANGES,
    SPAN,
    type TrafficMetric,
    type TrafficRange,
    type TrafficReport,
    axisFormatOf,
    formatOf,
    headline,
    markersOf,
    ms,
    rate,
    readoutNotes,
    readoutTitle,
    usageOf,
    versionColors,
    xFormat,
    zeroUsage,
} from "~/lib/traffic";
import { isDeployed } from "./header";

let sharedRange: TrafficRange = "24h";
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function useTrafficRange(): [TrafficRange, (range: TrafficRange) => void] {
    const range = useSyncExternalStore(subscribe, () => sharedRange);
    return [
        range,
        (next) => {
            sharedRange = next;
            for (const listener of listeners) {
                listener();
            }
        },
    ];
}

function Choice<T extends string>({
    label,
    options,
    value,
    onValue,
}: {
    label: string;
    options: { key: T; label: string }[];
    value: T;
    onValue: (value: T) => void;
}) {
    return (
        <Select value={value} onValueChange={(next) => next && onValue(next as T)}>
            <SelectTrigger aria-label={label}>
                <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
                {options.map((option) => (
                    <SelectItem key={option.key} value={option.key}>
                        {option.label}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

export function RangeSwitch({
    range,
    onRange,
}: {
    range: TrafficRange;
    onRange: (range: TrafficRange) => void;
}) {
    return <Choice label="Time range" options={RANGES} value={range} onValue={onRange} />;
}

export function MetricSwitch({
    metric,
    onMetric,
}: {
    metric: TrafficMetric;
    onMetric: (metric: TrafficMetric) => void;
}) {
    return <Choice label="Metric" options={METRICS} value={metric} onValue={onMetric} />;
}

function MetricChart({
    row,
    report,
    range,
    metric,
    colors,
    height,
    title,
}: {
    row: ModelRow;
    report: TrafficReport | undefined;
    range: TrafficRange;
    metric: TrafficMetric;
    colors: Map<number, string>;
    height: number;
    title?: boolean;
}) {
    const custom = row.kind === "custom";
    const label = METRICS.find((item) => item.key === metric)?.label ?? "";
    const empty = !report || report.totals.requests === 0;
    const usage =
        report && !empty
            ? usageOf(report, metric, colors, custom, row.name)
            : zeroUsage(report, range, label);
    return (
        <div className="flex min-w-0 flex-col gap-2">
            {title && (
                <p className="flex items-baseline justify-between gap-3">
                    <span className="text-muted-foreground">{label}</span>
                    <span className="tabular-nums">
                        {!report
                            ? "–"
                            : metric === "p95"
                              ? ms(report.totals.p95_ms)
                              : headline(metric, report.totals)}
                    </span>
                </p>
            )}
            <LineChart
                rows={usage.rows}
                series={usage.series}
                format={formatOf(metric)}
                axisFormat={axisFormatOf(metric)}
                integer={metric === "requests"}
                label={`${label} for ${row.name} ${SPAN[range]}${custom ? ", by version" : ""}`}
                height={height}
                markers={report && !empty ? markersOf(report) : []}
                yDomain={empty ? EMPTY_DOMAIN[metric] : undefined}
                xFormat={xFormat(range)}
                readoutTitle={report ? readoutTitle(report) : undefined}
                readoutNotes={report && !empty ? readoutNotes(report) : undefined}
                legend={false}
            />
        </div>
    );
}

function VersionLegend({
    row,
    report,
    colors,
}: {
    row: ModelRow;
    report: TrafficReport | undefined;
    colors: Map<number, string>;
}) {
    if (!report || report.totals.requests === 0 || row.kind !== "custom") {
        return null;
    }
    const usage = usageOf(report, "requests", colors, true, row.name);
    return <ChartLegend series={usage.legend} />;
}

export function TrafficCharts({
    row,
    versions,
    report,
    range,
    metrics,
}: {
    row: ModelRow;
    versions: VersionInfo[];
    report: TrafficReport | undefined;
    range: TrafficRange;
    metrics: TrafficMetric[];
}) {
    const colors = versionColors(versions);
    const single = metrics.length === 1;
    return (
        <div className="flex min-w-0 flex-col gap-4">
            <VersionLegend row={row} report={report} colors={colors} />
            <div className={single ? "flex flex-col" : "grid gap-x-8 gap-y-6 @2xl:grid-cols-2"}>
                {metrics.map((metric) => (
                    <MetricChart
                        key={metric}
                        row={row}
                        report={report}
                        range={range}
                        metric={metric}
                        colors={colors}
                        height={single ? 200 : 140}
                        title
                    />
                ))}
            </div>
        </div>
    );
}

export function TrafficChart({
    row,
    versions,
    report,
    range,
    onRange,
    height = 200,
    emptyHint,
}: {
    row: ModelRow;
    versions: VersionInfo[];
    report: TrafficReport | undefined;
    range: TrafficRange;
    onRange?: (range: TrafficRange) => void;
    height?: number;
    emptyHint?: string | null;
}) {
    const [metric, setMetric] = useState<TrafficMetric>("requests");
    const colors = versionColors(versions);
    const empty = !report || report.totals.requests === 0;
    return (
        <div className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <VersionLegend row={row} report={report} colors={colors} />
                <div className="ml-auto flex items-center gap-2">
                    <MetricSwitch metric={metric} onMetric={setMetric} />
                    {onRange && <RangeSwitch range={range} onRange={onRange} />}
                </div>
            </div>
            <MetricChart
                row={row}
                report={report}
                range={range}
                metric={metric}
                colors={colors}
                height={height}
            />
            {empty && emptyHint && <p className="text-muted-foreground">{emptyHint}</p>}
        </div>
    );
}

function Footer({ row, report }: { row: ModelRow; report: TrafficReport | undefined }) {
    const replicas = report?.replicas ?? [];
    const quiet = !report || report.totals.requests === 0;
    if (quiet && !isDeployed(row)) {
        return "Not deployed yet · deploy it to start receiving requests";
    }
    const lead = quiet
        ? "No traffic"
        : `p95 ${ms(report.totals.p95_ms)} · ${rate(report.totals.error_rate ?? 0)} errors`;
    return (
        <>
            {`${lead} · ${replicas.length} ${replicas.length === 1 ? "replica" : "replicas"}`}
            {replicas.length > 0 && (
                <>
                    {" in "}
                    <PoolPlaces places={replicas} />
                </>
            )}
        </>
    );
}

const ALL_METRICS = METRICS.map((item) => item.key);

export function UsagePanel({ row, versions }: { row: ModelRow; versions: VersionInfo[] }) {
    const [range, setRange] = useTrafficRange();
    const [metrics, setMetrics] = useState<TrafficMetric[]>(ALL_METRICS);
    const traffic = useModelTraffic(row.key, range);
    const shown = ALL_METRICS.filter((metric) => metrics.includes(metric));
    return (
        <PanelSection
            icon={ChartLine}
            title="Usage"
            description={
                row.kind === "base"
                    ? "Requests to this model."
                    : "Requests to the live model, by version."
            }
            actions={
                <>
                    <CheckboxSelect
                        label="Metrics"
                        allLabel="All metrics"
                        noun="metrics"
                        options={METRICS.map((item) => ({ value: item.key, label: item.label }))}
                        value={metrics}
                        onValueChange={(next) =>
                            setMetrics(next.length > 0 ? (next as TrafficMetric[]) : ALL_METRICS)
                        }
                    />
                    <RangeSwitch range={range} onRange={setRange} />
                </>
            }
        >
            <div className="@container flex min-w-0 flex-col gap-4">
                <TrafficCharts
                    row={row}
                    versions={versions}
                    report={traffic.data}
                    range={range}
                    metrics={shown}
                />
                <ErrorLine error={traffic.error} onRetry={traffic.refetch} />
                <p className="text-sm text-muted-foreground tabular-nums">
                    <Footer row={row} report={traffic.data} />
                </p>
            </div>
        </PanelSection>
    );
}
