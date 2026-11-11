import { useRouterState } from "@tanstack/react-router";
import { Box, ChartLine } from "lucide-react";
import {
    EmptyState,
    Link,
    SegmentedTabs,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "obp-ui";
import { useEffect } from "react";
import { PageHeader } from "~/components/PageHeader";
import { Page, PanelSection, PanelSections } from "~/components/Section";
import { count } from "~/lib/format";
import { useListSearch } from "~/lib/listSearch";
import {
    CallersSection,
    ErrorsSection,
    LAST,
    LatencySection,
    LineKey,
    RequestLogSection,
    SummaryStrip,
    callerRows,
    periodOf,
    summaryPair,
} from "./flowMonitorParts";
import { monitorHref } from "./flowMonitoring";
import {
    ERROR_KINDS,
    type Source,
    type UsageRange,
    callerLabel,
    logOf,
    summaryOf,
} from "./flowTraffic";
import { OTHER_COLOR, fleetColors, fleetUsageOf, useUsageRange } from "./flowUsage";
import { RANGES, SPAN, UsageChart, gpu, ms, rate } from "./flowUsageChart";
import { type ApiKey, FLOW, type FlowModel, modelHref, useFlowState } from "./modelsFlowData";

const ALL = "all";
const FILTERS = ["model", "key", "error"] as const;

function ByModelSection({
    sources,
    range,
    colorOf,
}: {
    sources: Source[];
    range: UsageRange;
    colorOf: (slug: string) => string;
}) {
    const rows = sources
        .map((source) => ({ model: source.model, totals: summaryOf([source], range) }))
        .sort((a, b) => b.totals.requests - a.totals.requests);
    const total = rows.reduce((sum, row) => sum + row.totals.requests, 0);
    return (
        <PanelSection
            icon={Box}
            title="By model"
            description={`Each deployed model ${SPAN[range]}, busiest first.`}
            flush
        >
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead className="pl-panel">Model</TableHead>
                        <TableHead className="text-right">Requests</TableHead>
                        <TableHead className="text-right">Share</TableHead>
                        <TableHead className="text-right">Latency p95</TableHead>
                        <TableHead className="text-right">Error rate</TableHead>
                        <TableHead className="text-right">Cost / 1k req.</TableHead>
                        <TableHead className="pr-panel text-right">Cost</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {rows.map(({ model, totals }) => (
                        <TableRow key={model.slug}>
                            <TableCell className="pl-panel">
                                <span className="flex items-center gap-2">
                                    <LineKey color={colorOf(model.slug)} />
                                    <Link
                                        href={modelHref(model.slug, "monitoring")}
                                        className="font-medium hover:underline"
                                    >
                                        {model.name}
                                    </Link>
                                </span>
                            </TableCell>
                            <TableCell className="text-right">{count(totals.requests)}</TableCell>
                            <TableCell className="text-right">
                                {total > 0
                                    ? `${((totals.requests * 100) / total).toFixed(1)}%`
                                    : "–"}
                            </TableCell>
                            <TableCell className="text-right">
                                {totals.requests > 0 ? ms(totals.p95) : "–"}
                            </TableCell>
                            <TableCell
                                className={
                                    totals.errors > model.usualErrors * 3
                                        ? "text-right text-destructive"
                                        : "text-right"
                                }
                            >
                                {totals.requests > 0 ? rate(totals.errors) : "–"}
                            </TableCell>
                            <TableCell className="text-right">
                                {totals.requests > 0 ? gpu(totals.costPer1k) : "–"}
                            </TableCell>
                            <TableCell className="pr-panel text-right">
                                {gpu(totals.cost)}
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </PanelSection>
    );
}

function sourcesFor(
    deployed: FlowModel[],
    keysOf: (slug: string) => ApiKey[],
    model: string | undefined,
    key: string | undefined,
): Source[] {
    return deployed
        .filter((item) => !model || item.slug === model)
        .map((item) => ({ model: item, keys: keysOf(item.slug) }))
        .filter((source) => !key || source.keys.some((item) => item.id === key))
        .map((source) => (key ? { ...source, caller: key } : source));
}

function useScrollToLog(ready: boolean) {
    const hash = useRouterState({ select: (state) => state.location.hash });
    const search = useRouterState({ select: (state) => state.location.searchStr });
    useEffect(() => {
        if (ready && hash === "log" && search !== undefined) {
            document.getElementById("log")?.scrollIntoView({ block: "start" });
        }
    }, [hash, search, ready]);
}

export function FlowMonitorPage() {
    const state = useFlowState();
    const keysOf = (slug: string) => state.keys[slug] ?? [];
    const [range, setRange] = useUsageRange();
    const { search, update } = useListSearch(`${FLOW}/monitor`, FILTERS);
    const deployed = state.models.filter((model) => model.deployed);
    const keys = deployed.flatMap((model) => keysOf(model.slug).map((key) => ({ key, model })));
    const model = deployed.some((item) => item.slug === search.model) ? search.model : undefined;
    const key = keys.some((item) => item.key.id === search.key) ? search.key : undefined;
    const error = ERROR_KINDS.find((item) => item.key === search.error);
    const sources = sourcesFor(deployed, keysOf, model, key);
    const colors = fleetColors(state.models, keysOf);
    const colorOf = (slug: string) =>
        colors.find((item) => item.slug === slug)?.color ?? OTHER_COLOR;
    const single = sources.length === 1 ? sources[0].model : null;
    const { now, before, comparable } = summaryPair(sources, range);
    const subject = single ? single.name : "all models";
    const log = logOf(
        sources.map((source) => source.model),
        keysOf,
    ).filter((entry) => (!key || entry.caller === key) && (!error || entry.kind === error.key));
    useScrollToLog(deployed.length > 0);
    const linkWith = (patch: Record<string, string | undefined>) =>
        monitorHref(
            Object.fromEntries(
                Object.entries({ model, key, error: error?.key, ...patch }).filter(
                    (entry): entry is [string, string] => Boolean(entry[1]),
                ),
            ),
        );
    return (
        <Page wide>
            <PageHeader
                title="Monitor"
                caption="Traffic across the deployed models: requests, latency, errors and cost."
            />
            {deployed.length === 0 ? (
                <EmptyState variant="panel" title="Nothing deployed yet">
                    Deploy a model and its requests, latency, errors and cost show here.
                </EmptyState>
            ) : (
                <>
                    <div className="flex flex-wrap items-center gap-3">
                        <SegmentedTabs
                            tabs={RANGES}
                            active={range}
                            onSelect={(value) => setRange(value as UsageRange)}
                        />
                        <Select
                            value={model ?? ALL}
                            onValueChange={(value) =>
                                update({ model: value === ALL ? undefined : String(value) })
                            }
                        >
                            <SelectTrigger aria-label="Model" className="w-auto min-w-48">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value={ALL}>All models</SelectItem>
                                {deployed.map((item) => (
                                    <SelectItem key={item.slug} value={item.slug}>
                                        {item.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <Select
                            value={key ?? ALL}
                            onValueChange={(value) =>
                                update({ key: value === ALL ? undefined : String(value) })
                            }
                        >
                            <SelectTrigger aria-label="API key" className="w-auto min-w-48">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value={ALL}>All API keys</SelectItem>
                                {keys.map((item) => (
                                    <SelectItem key={item.key.id} value={item.key.id}>
                                        {`${item.key.prefix} · ${item.model.name}`}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <PanelSections>
                        <PanelSection
                            icon={ChartLine}
                            title="Traffic"
                            description={`${LAST[range]}, by model. Changes compare with ${periodOf(range)}.`}
                        >
                            <div className="flex flex-col gap-6">
                                <SummaryStrip
                                    now={now}
                                    before={before}
                                    usual={single ? single.usualErrors : null}
                                    comparable={comparable}
                                />
                                <UsageChart
                                    load={(metric) => fleetUsageOf(sources, range, metric, colors)}
                                    range={range}
                                    subject={subject}
                                    by="by model"
                                    height={300}
                                    headline={false}
                                    empty={now.requests === 0}
                                    emptyHint={null}
                                />
                            </div>
                        </PanelSection>
                        <LatencySection sources={sources} range={range} subject={subject} />
                        <ErrorsSection
                            sources={sources}
                            range={range}
                            subject={subject}
                            usual={single ? single.usualErrors : null}
                            logHref={(kind) => linkWith({ error: kind })}
                        />
                        <ByModelSection sources={sources} range={range} colorOf={colorOf} />
                        <CallersSection rows={callerRows(sources, range)} range={range} showModel />
                        <RequestLogSection
                            anchor="log"
                            entries={log}
                            callerName={(id) => callerLabel(state.models, keysOf, id)}
                            description={
                                error
                                    ? `Only ${error.label.toLowerCase()} errors, newest first.`
                                    : "Newest first. Prompts and answers stay on this install."
                            }
                            actions={
                                error ? (
                                    <Link
                                        href={linkWith({ error: undefined })}
                                        className="text-sm text-primary hover:underline"
                                    >
                                        Show every request
                                    </Link>
                                ) : undefined
                            }
                            empty="No requests match these filters."
                        />
                    </PanelSections>
                </>
            )}
        </Page>
    );
}
