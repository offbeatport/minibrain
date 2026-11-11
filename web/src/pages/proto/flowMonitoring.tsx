import { ChartLine, History, Layers } from "lucide-react";
import {
    Badge,
    EmptyState,
    Link,
    SegmentedTabs,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "obp-ui";
import { PanelSection, PanelSections } from "~/components/Section";
import { count } from "~/lib/format";
import {
    CallersSection,
    ErrorsSection,
    LAST,
    LatencySection,
    RequestLogSection,
    SummaryStrip,
    callerRows,
    periodOf,
    summaryPair,
} from "./flowMonitorParts";
import {
    type Source,
    type UsageRange,
    callerLabel,
    groupsOf,
    logOf,
    totalsOf,
} from "./flowTraffic";
import { usageOf, useUsageRange } from "./flowUsage";
import { RANGES, SPAN, UsageChart, gpu, ms, rate } from "./flowUsageChart";
import { FLOW, type FlowModel, modelHref, useFlowState, versionHref } from "./modelsFlowData";

export function monitorHref(search: Record<string, string>): string {
    const params = new URLSearchParams(search).toString();
    return `${FLOW}/monitor${params ? `?${params}` : ""}#log`;
}

type PartRow = {
    key: string;
    label: string;
    href: string | null;
    role: { text: string; variant: "success" | "info" | "neutral" } | null;
    requests: number;
    p95: number;
    errors: number;
    cost: number;
};

function partRows(model: FlowModel, source: Source, range: UsageRange): PartRow[] {
    const groups = groupsOf([source], range, (_, cell) => cell.part);
    const rows = [...groups.entries()].map(([part, acc]): PartRow => {
        const totals = totalsOf(acc);
        const base = {
            key: part,
            requests: totals.requests,
            p95: totals.p95,
            errors: totals.errors,
            cost: totals.cost,
        };
        if (model.kind === "base") {
            const variant = model.variants.find((item) => item.id === part);
            return {
                ...base,
                label: variant ? `${variant.format} · ${variant.apiName}` : part,
                href: modelHref(model.slug, "variants"),
                role: variant?.live ? { text: "Deployed", variant: "success" } : null,
            };
        }
        const number = Number(part.slice(1));
        const canary = model.canary?.version === number;
        const live = model.live === number;
        return {
            ...base,
            label: `v${number}`,
            href: versionHref(model.slug, number),
            role: canary
                ? { text: `Canary ${model.canary?.share}%`, variant: "info" }
                : live
                  ? {
                        text: model.canary ? `Live ${100 - model.canary.share}%` : "Live",
                        variant: "success",
                    }
                  : { text: "Earlier", variant: "neutral" },
        };
    });
    return rows.sort((a, b) => b.label.localeCompare(a.label, undefined, { numeric: true }));
}

function PartsSection({
    model,
    source,
    range,
}: { model: FlowModel; source: Source; range: UsageRange }) {
    const rows = partRows(model, source, range);
    const total = rows.reduce((sum, row) => sum + row.requests, 0);
    const noun = model.kind === "base" ? "Variant" : "Version";
    return (
        <PanelSection
            icon={model.kind === "base" ? Layers : History}
            title={`By ${noun.toLowerCase()}`}
            description={
                model.canary
                    ? `Each version ${SPAN[range]}. The live pointer splits traffic: v${model.live} ${100 - model.canary.share}% · v${model.canary.version} ${model.canary.share}%.`
                    : `Each ${noun.toLowerCase()} that answered ${SPAN[range]}.`
            }
            flush
        >
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead className="pl-panel">{noun}</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Requests</TableHead>
                        <TableHead className="text-right">Share</TableHead>
                        <TableHead className="text-right">Latency p95</TableHead>
                        <TableHead className="text-right">Error rate</TableHead>
                        <TableHead className="pr-panel text-right">Cost</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {rows.map((row) => (
                        <TableRow key={row.key}>
                            <TableCell className="pl-panel">
                                {row.href ? (
                                    <Link href={row.href} className="font-medium hover:underline">
                                        {row.label}
                                    </Link>
                                ) : (
                                    row.label
                                )}
                            </TableCell>
                            <TableCell>
                                {row.role && (
                                    <Badge variant={row.role.variant}>{row.role.text}</Badge>
                                )}
                            </TableCell>
                            <TableCell className="text-right">{count(row.requests)}</TableCell>
                            <TableCell className="text-right">
                                {total > 0 ? `${((row.requests * 100) / total).toFixed(1)}%` : "–"}
                            </TableCell>
                            <TableCell className="text-right">{ms(row.p95)}</TableCell>
                            <TableCell
                                className={
                                    row.errors > model.usualErrors * 3
                                        ? "text-right text-destructive"
                                        : "text-right"
                                }
                            >
                                {rate(row.errors)}
                            </TableCell>
                            <TableCell className="pr-panel text-right">{gpu(row.cost)}</TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </PanelSection>
    );
}

function emptyText(model: FlowModel, range: UsageRange): string {
    if (model.live === null && model.kind !== "base") {
        return "Not deployed, so its name answers nothing. Make a version live to deploy it.";
    }
    if (!model.deployed) {
        return `${model.name} is not deployed, so nothing calls it. Deploy it from the header.`;
    }
    return `No requests ${SPAN[range]}. Latency, errors, versions and callers show here once requests arrive.`;
}

export function ModelMonitoring({ model }: { model: FlowModel }) {
    const state = useFlowState();
    const keys = state.keys[model.slug] ?? [];
    const [range, setRange] = useUsageRange();
    const source: Source = { model, keys };
    const { now, before, comparable } = summaryPair([source], range);
    const empty = now.requests === 0;
    const never = usageOf(model, "30d", "requests", keys).total === 0;
    const log = logOf([model], (slug) => state.keys[slug] ?? []).slice(0, 8);
    const callerName = (id: string) =>
        callerLabel(state.models, (slug) => state.keys[slug] ?? [], id);
    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <SegmentedTabs
                    tabs={RANGES}
                    active={range}
                    onSelect={(key) => setRange(key as UsageRange)}
                />
                <Link href={`${FLOW}/monitor`} className="text-sm text-primary hover:underline">
                    All models in Monitor →
                </Link>
            </div>
            <PanelSections>
                <PanelSection
                    icon={ChartLine}
                    title="Traffic"
                    description={`${LAST[range]}, by the version that answered. Changes compare with ${periodOf(range)}.`}
                >
                    <div className="flex flex-col gap-6">
                        {!never && (
                            <SummaryStrip
                                now={now}
                                before={before}
                                usual={model.usualErrors}
                                comparable={comparable}
                            />
                        )}
                        <UsageChart
                            load={(metric) => usageOf(model, range, metric, keys)}
                            range={range}
                            subject={model.name}
                            by={model.kind === "base" ? null : "by version"}
                            height={300}
                            headline={false}
                            empty={never}
                            emptyHint={emptyText(model, range)}
                        />
                    </div>
                </PanelSection>
                {never ? null : empty ? (
                    <EmptyState variant="panel" title="No traffic to show">
                        {emptyText(model, range)}
                    </EmptyState>
                ) : (
                    <>
                        <LatencySection sources={[source]} range={range} subject={model.name} />
                        <ErrorsSection
                            sources={[source]}
                            range={range}
                            subject={model.name}
                            usual={model.usualErrors}
                            logHref={(kind) => monitorHref({ model: model.slug, error: kind })}
                        />
                        <PartsSection model={model} source={source} range={range} />
                        <CallersSection
                            rows={callerRows([source], range)}
                            range={range}
                            showModel={false}
                        />
                        <RequestLogSection
                            entries={log}
                            callerName={callerName}
                            description="The latest requests, newest first. Prompts and answers stay on this install."
                            actions={
                                <Link
                                    href={monitorHref({ model: model.slug })}
                                    className="text-sm text-primary hover:underline"
                                >
                                    Full log in Monitor →
                                </Link>
                            }
                            empty="No requests yet."
                        />
                    </>
                )}
            </PanelSections>
        </div>
    );
}
