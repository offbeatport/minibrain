import { CircleAlert, KeyRound, Logs, Timer } from "lucide-react";
import { Link, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "obp-ui";
import type { ReactNode } from "react";
import { PanelSection } from "~/components/Section";
import { StatusText } from "~/components/models/StatusText";
import { count } from "~/lib/format";
import {
    ERROR_KINDS,
    type ErrorKind,
    type LogEntry,
    SLO_MS,
    type Source,
    type Totals,
    type UsageRange,
    callersOf,
    coveredFor,
    errorsOf,
    summaryOf,
} from "./flowTraffic";
import { errorRateOf, latencyOf } from "./flowUsage";
import { LineChart, SPAN, fineRate, gpu, ms, rate } from "./flowUsageChart";

const PERIOD: Record<UsageRange, string> = {
    "24h": "the previous 24 hours",
    "7d": "the previous 7 days",
    "30d": "the previous 30 days",
};

export const LAST: Record<UsageRange, string> = {
    "24h": "The last 24 hours",
    "7d": "The last 7 days",
    "30d": "The last 30 days",
};

export function periodOf(range: UsageRange): string {
    return PERIOD[range];
}

function signed(value: number, digits: number, unit: string): string {
    const shown = Math.abs(value).toFixed(digits);
    if (Number(shown) === 0) {
        return `±0${unit}`;
    }
    return `${value > 0 ? "+" : "−"}${shown}${unit}`;
}

function relative(now: number, before: number): string {
    return signed(((now - before) / before) * 100, 0, "%");
}

function Figure({
    label,
    value,
    delta,
    alert = false,
}: {
    label: string;
    value: ReactNode;
    delta: string | null;
    alert?: boolean;
}) {
    return (
        <div className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd
                className={cn(
                    "text-xl tabular-nums",
                    alert ? "text-destructive" : "text-foreground",
                )}
            >
                {value}
            </dd>
            <dd className="text-sm text-muted-foreground tabular-nums">{delta ?? " "}</dd>
        </div>
    );
}

export function SummaryStrip({
    now,
    before,
    usual,
    comparable,
}: {
    now: Totals;
    before: Totals;
    usual: number | null;
    comparable: boolean;
}) {
    const empty = now.requests === 0;
    const compare = comparable && before.requests > 0 && !empty;
    const none = empty ? null : comparable ? "No earlier traffic" : "No full earlier period";
    return (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-5">
            <Figure
                label="Requests"
                value={count(now.requests)}
                delta={compare ? relative(now.requests, before.requests) : none}
            />
            <Figure
                label="Latency p95"
                value={empty ? "–" : ms(now.p95)}
                delta={compare ? relative(now.p95, before.p95) : none}
            />
            <Figure
                label="Latency p99"
                value={empty ? "–" : ms(now.p99)}
                delta={compare ? relative(now.p99, before.p99) : none}
            />
            <Figure
                label="Error rate"
                value={empty ? "–" : rate(now.errors)}
                alert={usual !== null && now.errors > usual * 3}
                delta={compare ? signed((now.errors - before.errors) * 100, 1, " pts") : none}
            />
            <Figure
                label="Cost / 1k requests"
                value={empty ? "–" : gpu(now.costPer1k)}
                delta={compare ? relative(now.costPer1k, before.costPer1k) : none}
            />
        </dl>
    );
}

export function summaryPair(sources: Source[], range: UsageRange) {
    return {
        now: summaryOf(sources, range),
        before: summaryOf(sources, range, true),
        comparable: sources.some((source) => coveredFor(source.model, range)),
    };
}

export function LatencySection({
    sources,
    range,
    subject,
}: {
    sources: Source[];
    range: UsageRange;
    subject: string;
}) {
    const lines = latencyOf(sources, range);
    return (
        <PanelSection
            icon={Timer}
            title="Latency"
            description={`p50, p95 and p99 ${SPAN[range]}. The dashed line is the ${SLO_MS} ms SLO.`}
        >
            <LineChart
                rows={lines.rows}
                series={lines.series}
                range={range}
                bucketHours={lines.bucketHours}
                format={ms}
                label={`Latency percentiles for ${subject} ${SPAN[range]}`}
                levels={[{ at: SLO_MS, label: `SLO ${SLO_MS} ms` }]}
                height={220}
            />
        </PanelSection>
    );
}

export function minutesAgo(minutes: number | null): string {
    if (minutes === null) {
        return "–";
    }
    if (minutes < 60) {
        return `${minutes} min ago`;
    }
    if (minutes < 48 * 60) {
        return `${Math.floor(minutes / 60)} h ago`;
    }
    return `${Math.floor(minutes / (24 * 60))} d ago`;
}

export function ErrorsSection({
    sources,
    range,
    subject,
    usual,
    logHref,
}: {
    sources: Source[];
    range: UsageRange;
    subject: string;
    usual: number | null;
    logHref: (kind: ErrorKind) => string;
}) {
    const lines = errorRateOf(sources, range);
    const kinds = errorsOf(sources, range);
    return (
        <PanelSection
            icon={CircleAlert}
            title="Errors"
            description={`The share of requests that failed ${SPAN[range]}, and what failed.`}
            flush
        >
            <div className="p-panel">
                <LineChart
                    rows={lines.rows}
                    series={lines.series}
                    range={range}
                    bucketHours={lines.bucketHours}
                    format={fineRate}
                    label={`Error rate for ${subject} ${SPAN[range]}`}
                    levels={usual === null ? [] : [{ at: usual, label: `Usually ${rate(usual)}` }]}
                    legend={false}
                    height={160}
                />
            </div>
            <Table className="border-t">
                <TableHeader>
                    <TableRow>
                        <TableHead className="pl-panel">Type</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Requests</TableHead>
                        <TableHead className="text-right">Last seen</TableHead>
                        <TableHead className="pr-panel text-right">
                            <span className="sr-only">Log</span>
                        </TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {kinds.map((kind) => (
                        <TableRow key={kind.key}>
                            <TableCell className="pl-panel">{kind.label}</TableCell>
                            <TableCell className="font-mono text-sm">{kind.status}</TableCell>
                            <TableCell className="text-right">{count(kind.count)}</TableCell>
                            <TableCell className="text-right text-muted-foreground">
                                {minutesAgo(kind.minutesAgo)}
                            </TableCell>
                            <TableCell className="pr-panel text-right">
                                {kind.count > 0 ? (
                                    <Link
                                        href={logHref(kind.key)}
                                        className="text-primary hover:underline"
                                    >
                                        In the log →
                                    </Link>
                                ) : null}
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </PanelSection>
    );
}

type CallerRow = {
    id: string;
    label: string;
    key: boolean;
    client: string;
    model: string;
    totals: Totals;
};

export function callerRows(sources: Source[], range: UsageRange): CallerRow[] {
    return sources
        .flatMap((source) =>
            callersOf(source.model, source.keys)
                .filter((caller) => !source.caller || caller.id === source.caller)
                .map((caller) => ({
                    id: caller.id,
                    label: caller.label,
                    key: caller.key,
                    client: caller.client,
                    model: source.model.name,
                    totals: summaryOf([{ ...source, caller: caller.id }], range),
                })),
        )
        .filter((row) => row.totals.requests > 0)
        .sort((a, b) => b.totals.requests - a.totals.requests)
        .slice(0, 8);
}

export function CallersSection({
    rows,
    range,
    showModel,
}: {
    rows: CallerRow[];
    range: UsageRange;
    showModel: boolean;
}) {
    const total = rows.reduce((sum, row) => sum + row.totals.requests, 0);
    return (
        <PanelSection
            icon={KeyRound}
            title="Callers"
            description={`The API keys and clients that sent the most requests ${SPAN[range]}.`}
            flush
        >
            {rows.length === 0 ? (
                <p className="p-panel text-muted-foreground">{`No requests ${SPAN[range]}.`}</p>
            ) : (
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead className="pl-panel">Caller</TableHead>
                            <TableHead>Client</TableHead>
                            {showModel && <TableHead>Model</TableHead>}
                            <TableHead className="text-right">Requests</TableHead>
                            <TableHead className="text-right">Share</TableHead>
                            <TableHead className="pr-panel text-right">Error rate</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.map((row) => (
                            <TableRow key={row.id}>
                                <TableCell
                                    className={cn("pl-panel", row.key && "font-mono text-sm")}
                                >
                                    {row.label}
                                </TableCell>
                                <TableCell className="font-mono text-sm text-muted-foreground">
                                    {row.client}
                                </TableCell>
                                {showModel && <TableCell>{row.model}</TableCell>}
                                <TableCell className="text-right">
                                    {count(row.totals.requests)}
                                </TableCell>
                                <TableCell className="text-right">
                                    {total > 0
                                        ? `${Math.round((row.totals.requests * 100) / total)}%`
                                        : "–"}
                                </TableCell>
                                <TableCell className="pr-panel text-right">
                                    {rate(row.totals.errors)}
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            )}
        </PanelSection>
    );
}

function statusOf(entry: LogEntry): ReactNode {
    if (entry.kind === null) {
        return <StatusText tone="success">200</StatusText>;
    }
    const kind = ERROR_KINDS.find((item) => item.key === entry.kind);
    return (
        <StatusText tone={entry.kind === "safety" ? "warning" : "destructive"}>
            {`${kind?.status === "Refused" ? "" : `${kind?.status} `}${kind?.label.toLowerCase()}`}
        </StatusText>
    );
}

export function RequestLogSection({
    entries,
    callerName,
    description,
    actions,
    empty,
    anchor,
}: {
    entries: LogEntry[];
    callerName: (id: string) => string;
    description: ReactNode;
    actions?: ReactNode;
    empty: string;
    anchor?: string;
}) {
    return (
        <PanelSection
            icon={Logs}
            anchor={anchor}
            title="Request log"
            description={description}
            actions={actions}
            flush
        >
            {entries.length === 0 ? (
                <p className="p-panel text-muted-foreground">{empty}</p>
            ) : (
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead className="pl-panel">Time</TableHead>
                            <TableHead>Model</TableHead>
                            <TableHead>Caller</TableHead>
                            <TableHead>Request</TableHead>
                            <TableHead className="text-right">Latency</TableHead>
                            <TableHead className="pr-panel">Status</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {entries.map((entry) => (
                            <TableRow key={entry.id}>
                                <TableCell className="pl-panel font-mono text-sm whitespace-nowrap text-muted-foreground">
                                    {minutesAgo(entry.minutesAgo)}
                                </TableCell>
                                <TableCell className="font-mono text-sm">{entry.served}</TableCell>
                                <TableCell
                                    className={cn(
                                        "text-muted-foreground",
                                        !entry.caller.startsWith("playground:") &&
                                            "font-mono text-sm",
                                    )}
                                >
                                    {callerName(entry.caller)}
                                </TableCell>
                                <TableCell className="max-w-80 truncate" title={entry.question}>
                                    {entry.question}
                                </TableCell>
                                <TableCell className="text-right whitespace-nowrap">
                                    {ms(entry.ms)}
                                </TableCell>
                                <TableCell className="pr-panel">{statusOf(entry)}</TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            )}
        </PanelSection>
    );
}

export function LineKey({ color }: { color: string }) {
    return (
        <span
            aria-hidden="true"
            className="inline-block h-0.5 w-3 shrink-0 rounded-full"
            style={{ background: color }}
        />
    );
}
