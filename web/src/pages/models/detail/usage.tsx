import { ChartLine } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "obp-ui";
import { useState, useSyncExternalStore } from "react";
import type { ModelRow, VersionInfo } from "~/api/client";
import { useModelTraffic } from "~/api/modelPageQueries";
import { PoolPlaces } from "~/components/PoolLink";
import { ErrorLine, PanelSection } from "~/components/Section";
import { LineChart } from "~/components/charts/LineChart";
import {
    METRICS,
    RANGES,
    SPAN,
    type TrafficMetric,
    type TrafficRange,
    type TrafficReport,
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
} from "~/lib/traffic";
import { isDeployed } from "./header";

let sharedRange: TrafficRange = "30d";
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

export function TrafficChart({
    row,
    versions,
    report,
    range,
    onRange,
    height = 200,
    showHeadline = true,
    emptyHint,
    metric: chosen,
    onMetric,
}: {
    row: ModelRow;
    versions: VersionInfo[];
    report: TrafficReport | undefined;
    range: TrafficRange;
    onRange?: (range: TrafficRange) => void;
    height?: number;
    showHeadline?: boolean;
    emptyHint?: string | null;
    metric?: TrafficMetric;
    onMetric?: (metric: TrafficMetric) => void;
}) {
    const [own, setOwn] = useState<TrafficMetric>("requests");
    const metric = chosen ?? own;
    const controls = !onMetric;
    const custom = row.kind === "custom";
    const colors = versionColors(versions);
    const usage = report
        ? usageOf(report, metric, colors, custom, row.name)
        : { rows: [], series: [], legend: [] };
    const empty = !report || report.totals.requests === 0;
    const label = METRICS.find((item) => item.key === metric)?.label ?? "";
    const now = Date.now();
    const rows = usage.rows.length > 0 ? usage.rows : [{ step: now - 86400000 }, { step: now }];
    return (
        <div className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                {showHeadline && report && !empty ? (
                    <p className="flex items-baseline gap-2">
                        <span className="text-xl tabular-nums">
                            {headline(metric, report.totals)}
                        </span>
                        <span className="text-base text-muted-foreground">{SPAN[range]}</span>
                    </p>
                ) : (
                    <span />
                )}
                {controls && (
                    <div className="flex items-center gap-2">
                        <MetricSwitch metric={metric} onMetric={setOwn} />
                        {onRange && <RangeSwitch range={range} onRange={onRange} />}
                    </div>
                )}
            </div>
            <LineChart
                rows={rows}
                series={usage.series}
                legendSeries={usage.legend}
                format={formatOf(metric)}
                label={`${label} for ${row.name} ${SPAN[range]}${custom ? ", by version" : ""}`}
                height={height}
                markers={report ? markersOf(report) : []}
                xFormat={xFormat(range)}
                readoutTitle={report ? readoutTitle(report) : undefined}
                readoutNotes={report ? readoutNotes(report) : undefined}
                empty={empty ? { title: "No requests yet", hint: emptyHint } : null}
            />
        </div>
    );
}

function Footer({ row, report }: { row: ModelRow; report: TrafficReport | undefined }) {
    const replicas = report?.replicas ?? [];
    const quiet = !report || report.totals.requests === 0;
    if (quiet && !isDeployed(row)) {
        return "No traffic";
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

export function UsagePanel({ row, versions }: { row: ModelRow; versions: VersionInfo[] }) {
    const [range, setRange] = useTrafficRange();
    const [metric, setMetric] = useState<TrafficMetric>("requests");
    const traffic = useModelTraffic(row.key, range);
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
                    <MetricSwitch metric={metric} onMetric={setMetric} />
                    <RangeSwitch range={range} onRange={setRange} />
                </>
            }
        >
            <div className="flex min-w-0 flex-col gap-4">
                <TrafficChart
                    row={row}
                    versions={versions}
                    report={traffic.data}
                    range={range}
                    metric={metric}
                    onMetric={setMetric}
                    emptyHint={isDeployed(row) ? null : "Deploy it to start receiving requests"}
                />
                <ErrorLine error={traffic.error} onRetry={traffic.refetch} />
                <p className="text-sm text-muted-foreground tabular-nums">
                    <Footer row={row} report={traffic.data} />
                </p>
            </div>
        </PanelSection>
    );
}
