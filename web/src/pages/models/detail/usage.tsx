import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { ChartLine } from "lucide-react";
import { Button, Link, SegmentedTabs } from "obp-ui";
import { useState, useSyncExternalStore } from "react";
import { type ModelRow, type VersionInfo, api, unwrap } from "~/api/client";
import { type StatusAction, useModelTraffic } from "~/api/modelPageQueries";
import { keys, useModelPage } from "~/api/queries";
import { ErrorLine, PanelSection } from "~/components/Section";
import { LineChart } from "~/components/charts/LineChart";
import { StatusText } from "~/components/models/StatusText";
import { useCan } from "~/lib/access";
import { jobPageHref } from "~/lib/jobs";
import { modelPageHref, modelTrainHref, trainingJobHref } from "~/lib/modelLinks";
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
import { SwitchBaseDialog } from "../SwitchBaseDialog";
import { ConfirmAction, type Confirmation, useModelsRefresh } from "../dialogs";
import { deployConfirmation, isDeployed } from "./header";
import { MakeLiveDialog } from "./makeLive";

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

export function RangeSwitch({
    range,
    onRange,
}: {
    range: TrafficRange;
    onRange: (range: TrafficRange) => void;
}) {
    return (
        <SegmentedTabs
            tabs={RANGES}
            active={range}
            onSelect={(key) => onRange(key as TrafficRange)}
        />
    );
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
}: {
    row: ModelRow;
    versions: VersionInfo[];
    report: TrafficReport | undefined;
    range: TrafficRange;
    onRange?: (range: TrafficRange) => void;
    height?: number;
    showHeadline?: boolean;
    emptyHint?: string | null;
}) {
    const [metric, setMetric] = useState<TrafficMetric>("requests");
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
        <div className="flex min-w-0 flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <SegmentedTabs
                    tabs={METRICS}
                    active={metric}
                    onSelect={(key) => setMetric(key as TrafficMetric)}
                />
                {onRange && <RangeSwitch range={range} onRange={onRange} />}
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
                header={
                    showHeadline && report ? (
                        <p className="flex items-baseline gap-2">
                            <span className="text-xl tabular-nums">
                                {headline(metric, report.totals)}
                            </span>
                            <span className="text-sm text-muted-foreground">{SPAN[range]}</span>
                        </p>
                    ) : undefined
                }
                empty={empty ? { title: "No requests yet", hint: emptyHint } : null}
            />
        </div>
    );
}

function retryJob(jobId: number) {
    return unwrap(api.POST("/api/jobs/{job_id}/retry", { params: { path: { job_id: jobId } } }));
}

function jobHref(row: ModelRow, jobId: number): string {
    return row.kind === "custom" ? trainingJobHref(jobId) : jobPageHref(jobId);
}

function hrefOf(row: ModelRow, action: StatusAction): string | null {
    switch (action.kind) {
        case "open_job":
            return action.job_id ? jobHref(row, action.job_id) : null;
        case "open_monitoring":
            return modelPageHref(row.key, "monitoring");
        case "review_feedback":
            return `/feedback?model=${encodeURIComponent(row.key)}`;
        case "add_data":
            return modelPageHref(row.key, "training");
        case "train":
            return modelTrainHref(row.key);
        case "create_custom":
            return `/models/new?base=${encodeURIComponent(row.key)}`;
        default:
            return null;
    }
}

export function StatusLine({ row, versions }: { row: ModelRow; versions: VersionInfo[] }) {
    const page = useModelPage(row.key);
    const can = useCan();
    const router = useRouter();
    const client = useQueryClient();
    const refresh = useModelsRefresh();
    const [promoting, setPromoting] = useState<number | null>(null);
    const [switching, setSwitching] = useState<string | null>(null);
    const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
    const retry = useMutation({
        mutationFn: retryJob,
        onSuccess: async (job) => {
            await client.invalidateQueries();
            router.history.push(jobHref(row, job.id));
        },
    });
    const status = page.data?.status;
    if (!status) {
        return <p className="min-h-6" />;
    }
    const action = status.action && (can.build || status.action.everyone) ? status.action : null;
    const href = action ? hrefOf(row, action) : null;
    const reload = async () => {
        await refresh();
        await client.invalidateQueries({ queryKey: keys.modelPage(row.key) });
    };
    const run = () => {
        if (!action) {
            return;
        }
        if (action.kind === "promote" && action.version !== null && action.version !== undefined) {
            setPromoting(action.version);
        } else if (action.kind === "deploy") {
            setConfirmation(deployConfirmation(row, isDeployed(row), reload));
        } else if (action.kind === "retry_job" && action.job_id) {
            retry.mutate(action.job_id);
        } else if (action.kind === "switch_base") {
            setSwitching(action.base ?? "");
        }
    };
    return (
        <>
            <p className="flex min-h-6 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 tabular-nums">
                <StatusText tone={status.tone} className="min-w-0 truncate">
                    {status.text}
                </StatusText>
                {action && (
                    <>
                        <span aria-hidden="true" className="text-faint">
                            ·
                        </span>
                        {href ? (
                            <Link href={href} className="text-primary hover:underline">
                                {action.label}
                            </Link>
                        ) : (
                            <Button
                                variant="link"
                                className="h-auto p-0"
                                disabled={retry.isPending}
                                onClick={run}
                            >
                                {action.label}
                            </Button>
                        )}
                    </>
                )}
            </p>
            <ErrorLine error={retry.error} />
            {row.kind === "custom" && (
                <>
                    <MakeLiveDialog
                        row={row}
                        versions={versions}
                        number={promoting}
                        onOpenChange={(open) => !open && setPromoting(null)}
                    />
                    <SwitchBaseDialog
                        row={switching !== null ? row : null}
                        preferred={switching || null}
                        onOpenChange={(open) => !open && setSwitching(null)}
                    />
                </>
            )}
            <ConfirmAction
                confirmation={confirmation}
                onOpenChange={(open) => !open && setConfirmation(null)}
            />
        </>
    );
}

function footerText(row: ModelRow, report: TrafficReport | undefined): string {
    const replicas = report?.replicas ?? [];
    const hosts = [...new Set(replicas.map((item) => item.host))];
    const serving = `${replicas.length} ${replicas.length === 1 ? "replica" : "replicas"}${hosts.length > 0 ? ` on ${hosts.join(", ")}` : ""}`;
    if (!report || report.totals.requests === 0) {
        return isDeployed(row) ? `No traffic · ${serving}` : "No traffic";
    }
    return `p95 ${ms(report.totals.p95_ms)} · ${rate(report.totals.error_rate ?? 0)} errors · ${serving}`;
}

export function UsagePanel({ row, versions }: { row: ModelRow; versions: VersionInfo[] }) {
    const [range, setRange] = useTrafficRange();
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
        >
            <div className="flex min-w-0 flex-col gap-4">
                <StatusLine row={row} versions={versions} />
                <TrafficChart
                    row={row}
                    versions={versions}
                    report={traffic.data}
                    range={range}
                    onRange={setRange}
                    emptyHint={isDeployed(row) ? null : "Deploy it to start receiving requests"}
                />
                <ErrorLine error={traffic.error} />
                <p className="text-sm text-muted-foreground tabular-nums">
                    {footerText(row, traffic.data)}
                </p>
            </div>
        </PanelSection>
    );
}
